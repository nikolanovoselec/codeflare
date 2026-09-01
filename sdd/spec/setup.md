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

### REQ-SETUP-001: First-time setup requires zero pre-configuration

**Intent:** A freshly deployed Codeflare instance must be configurable through the setup wizard without any prior manual setup of authentication, DNS, or storage.

**Applies To:** Admin

**Acceptance Criteria:**

1. Before setup completes, the setup-configure endpoint is publicly accessible (no authentication required). <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-001 AC1: POST /api/setup/configure is publicly accessible when setup:complete is not set in KV) -->
2. The deployer needs only a Cloudflare API token configured as a Worker secret; no other pre-configuration is required. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (Setup AC Coverage) -->
3. The Cloudflare API token is read from a Worker environment binding, not from the request body. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-001 AC3: CLOUDFLARE_API_TOKEN is read from environment binding not from request body) -->
4. The setup wizard provisions all necessary Cloudflare resources (R2 credentials, DNS records, Access applications, Turnstile widgets) from scratch. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-001 AC4: setup wizard creates R2 credentials, DNS records, and Access app resources) -->
5. The setup-status endpoint is always public and returns the configured flag, optional custom domain, and SaaS mode flag. <!-- @impl: src/routes/setup/handlers.ts::default --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-001 AC5: GET /api/setup/status is always public and returns configured, customDomain, saasMode shape) -->

**Constraints:**

- The pre-setup public window is intentionally open ([AD10](../../documentation/decisions/README.md#ad10-bootstrap-window-pre-setup-endpoints-csrf-and-worker-name-derivation)) to solve the bootstrap problem: authentication cannot be required before it is configured.
- Rate limiting and a short exposure window mitigate the open-endpoint risk.

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test ([Integration test](../../src/__tests__/setup-ac-coverage.test.ts))

**Status:** Implemented

---

### REQ-SETUP-002: Setup wizard configures domain, auth, R2 credentials, and Turnstile

**Intent:** A single `POST /api/setup/configure` call provisions all required Cloudflare resources and stores the resulting configuration in Workers KV.

**Applies To:** Admin

**Acceptance Criteria:**

1. The request body includes the custom domain, the user allowlist, the admin allowlist (subset of users), and an optional origin allowlist. <!-- @impl: src/routes/setup/index.ts::ConfigureBodySchema --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-002 AC1: request body requires customDomain (valid domain), allowedUsers (non-empty email array), adminUsers (non-empty email array, subset of allowedUsers)) -->
2. All fields are validated synchronously before streaming starts; invalid input is rejected with a 400 error. <!-- @impl: src/lib/request-helpers.ts::parseJsonBody --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (Setup AC Coverage) -->
3. Setup executes applicable steps in canonical slot order and streams each attempted transition. Deployment-mode and reconfiguration-only slots may be omitted, and enterprise configuration may add named extension steps; the slot contract and observable effects live in [REQ-SETUP-012](#req-setup-012-setup-wizard-step-sequence). <!-- @impl: src/routes/setup/index.ts::default --> <!-- @impl: src/routes/setup/shared.ts::withSetupRetry --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-002 AC3: configure streams per-step progress for all 7 setup steps) -->
4. Setup configuration state lives under the dedicated setup namespace. Application user records and per-user preferences created as setup outputs retain their canonical user/bucket namespaces. <!-- @impl: src/lib/kv-keys.ts::SETUP_KEYS --> <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (Setup AC Coverage) -->
5. The response stream ends with exactly one terminal completion object. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-002 AC5: response stream ends with exactly one object containing done: true) -->
6. Successful finalization persists setup completion and its timestamp. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-002 AC6: successful finalization persists setup completion and its timestamp) -->
7. Onboarding and SaaS setup provision Turnstile as an applicable setup step. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (Setup AC Coverage) -->

**Constraints:**

- Each Cloudflare API call uses exponential backoff (3 total attempts, 1s base delay).
- Circuit-breaker open errors are not retried.

**Priority:** P0

**Dependencies:** [REQ-SETUP-001](#req-setup-001-first-time-setup-requires-zero-pre-configuration)

**Verification:** Automated test ([Integration test](../../src/__tests__/setup-ac-coverage.test.ts))

**Status:** Implemented

---

### REQ-SETUP-003: Three deployment modes

**Intent:** Codeflare supports three deployment modes that determine authentication strategy and user provisioning.

**Applies To:** Admin

**Acceptance Criteria:**

1. Default mode uses Cloudflare Access authentication with manually allowlisted users via the setup wizard, gated by CF Access policies and a persistent allowlist. <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @test: src/__tests__/routes/setup-access-provisioning.test.ts (REQ-SETUP-003: CF Access provisioning gated by isSessionOidcMode + OAUTH_CLIENT_ID) -->
2. Onboarding mode presents a public waitlist landing page for unauthenticated visitors and routes authenticated users into the application; when GitHub OAuth (`OAUTH_CLIENT_ID`) is configured the Worker authenticates via its own GitHub-OIDC session cookie and the setup wizard skips CF Access provisioning. <!-- @impl: src/lib/onboarding.ts::isOnboardingLandingPageActive --> <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) -->
3. SaaS mode uses a branded login and session credentials when GitHub OAuth is configured; setup skips CF Access, auto-provisions pending users, and manages state without Access groups or policies. <!-- @impl: src/lib/onboarding.ts::isSaasModeActive --> <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) -->
4. Deployment mode is determined at deploy time via Worker bindings; the setup wizard skips CF Access provisioning in any session-OIDC mode (SaaS OR onboarding) with `OAUTH_CLIENT_ID` set, and provisions CF Access (groups, app, policy) plus the enterprise vault SW-bypass app otherwise. <!-- @impl: src/lib/onboarding.ts::isSessionOidcMode --> <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) -->
5. The frontend detects the active mode on load and renders the appropriate initial view: branded login for SaaS, setup wizard if unconfigured, or workspace redirect for default mode. <!-- @impl: web-ui/src/App.tsx::checkSetupStatus --> <!-- @test: web-ui/src/__tests__/components/App.test.tsx (App setup routing) -->

**Constraints:**

- Stress-test mode must not be active alongside SaaS mode (returns 503).
- A session-OIDC mode (SaaS or onboarding) without `OAUTH_CLIENT_ID` configured falls back to CF Access authentication, and the setup wizard provisions CF Access for it.
- The CF Access skip mirrors the runtime guard `isSessionOidcMode`, so a session-OIDC deployment never gets a stray Access app that would 302 the credential-less vault service-worker registration ([REQ-VAULT-017](vault.md#req-vault-017-silverbullet-native-service-worker)).

**Priority:** P0

**Dependencies:** [REQ-AUTH-001](authentication.md#req-auth-001-two-authentication-modes)

**Verification:** Automated test ([Integration test](../../src/__tests__/lib/onboarding.test.ts))

**Status:** Implemented

---

### REQ-SETUP-004: Setup is idempotent

**Intent:** Re-running the setup wizard with the same or updated inputs must safely update existing resources without creating duplicates or leaving orphaned state.

**Applies To:** User

**Acceptance Criteria:**

1. Every step uses create-or-update semantics: reads are non-mutating, derived values are deterministic from the token, secrets overwrite, DNS/route/Access/Turnstile provisioning is upsert-shaped. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) -->
2. If a previous run partially completed, a retry updates existing resources and continues from the first step. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-004 AC2: if previous run partially completed, retry starts from step 1 and updates existing resources) -->
3. Partial progress from failed runs is retained so the next call can resume. Setup is not marked complete on failure. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (Setup AC Coverage) -->
4. "Already exists" errors on Worker routes and DNS records are handled only after the existing resource is verified correct or updated to the desired state; an unverified or failed update fails setup. <!-- @impl: src/routes/setup/custom-domain.ts::handleConfigureCustomDomain --> <!-- @test: src/__tests__/routes/setup/custom-domain.test.ts (accepts an already-existing worker route only when its current state is correct) --> <!-- @test: src/__tests__/routes/setup/custom-domain.test.ts (updates an already-existing worker route whose state is wrong) --> <!-- @test: src/__tests__/routes/setup/custom-domain.test.ts (fails setup when an incorrect worker route cannot be updated) --> <!-- @test: src/__tests__/routes/setup/custom-domain.test.ts (resolves a duplicate DNS create and corrects its target and proxy state) -->
5. The "latest version not yet deployed" error class on secret writes triggers an automatic redeploy of the latest Worker version followed by a retry. <!-- @impl: src/routes/setup/secrets.ts::handleSetSecrets --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-004 AC5: error code 10215 on secret write triggers auto-deploy then retry) -->

**Constraints:**

- A persistent lock prevents concurrent configure runs and is released on completion or failure; staleness has an upper bound.
- The lock check returns an immediate error (with no step progress) if another configure run is already active and not yet stale.

**Priority:** P1

**Dependencies:** [REQ-SETUP-002](#req-setup-002-setup-wizard-configures-domain-auth-r2-credentials-and-turnstile)

**Verification:** Automated test ([Integration test](../../src/__tests__/setup-ac-coverage.test.ts))

**Status:** Implemented

---

### REQ-SETUP-005: Post-setup reconfiguration requires admin auth

**Intent:** After initial setup is complete, only authenticated administrators can reconfigure the deployment.

**Applies To:** Admin

**Acceptance Criteria:**

1. Once setup is complete, configure, token-detection, and prefill endpoints require valid authentication. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @manual: After completing setup, call configure, token-detection, and prefill without credentials and confirm each request is rejected before handler execution. -->
2. The authenticated principal must have the admin role. <!-- @impl: src/lib/access.ts::authenticateRequest --> <!-- @manual: After completing setup, call each protected setup endpoint as an authenticated non-admin and confirm each returns a forbidden response. -->
3. The setup-status endpoint remains always public and never returns secrets. <!-- @manual: Call setup status without credentials before and after setup, confirm success, and inspect the complete response for absence of token or secret values. -->
4. Authentication accepts either Cloudflare Access tokens or Worker-issued session credentials, verified through the shared auth middleware. <!-- @impl: src/lib/access.ts::authenticateRequest --> <!-- @manual: After completing setup, exercise a protected setup endpoint with each supported credential type and confirm the same admin gate is applied. -->

**Constraints:**

- Admin role is resolved from the application's user record store, not from CF Access group membership, so the gate behaves identically across deployment modes.
- In SaaS mode the Worker enforces admin status itself; CF Access is not consulted.

**Priority:** P1

**Dependencies:** [REQ-SETUP-001](#req-setup-001-first-time-setup-requires-zero-pre-configuration), [REQ-AUTH-005](authentication.md#req-auth-005-three-tier-authorization-middleware)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-SETUP-006: Setup streams progress via NDJSON

**Intent:** The setup configure endpoint must stream real-time progress as NDJSON so the client can display step-by-step status updates while the setup runs.

**Applies To:** User

**Acceptance Criteria:**

1. The response uses NDJSON as its content type. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-002 AC3: configure response is NDJSON with Content-Type application/x-ndjson) -->
2. Each line is a self-contained JSON object terminated by a newline. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-002 AC3: configure streams per-step progress for all 7 setup steps) --> <!-- @manual: Inspect a configure response body and confirm every JSON object, including the terminal object, ends with a newline. -->
3. Progress messages identify the step and report one of `running`, `success`, or `error`. <!-- @impl: src/routes/setup/shared.ts::SetupStep --> <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-002 AC3: configure streams per-step progress for all 7 setup steps) -->
4. Failure messages include a human-readable error description. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: web-ui/src/__tests__/stores/setup.test.ts (configure error with steps) -->
5. Every stream ends with exactly one terminal completion object that carries the overall success flag. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-002 AC5: response stream ends with exactly one object containing done: true) -->

**Constraints:**

- The stream is not retryable mid-progress; on failure the client must re-submit the full request.
- The exact terminal-completion payload shape and edge-case behavior is specified in [REQ-SETUP-011](#req-setup-011-setup-stream-completion-payload-contract).

**Priority:** P1

**Dependencies:** [REQ-SETUP-002](#req-setup-002-setup-wizard-configures-domain-auth-r2-credentials-and-turnstile)

**Verification:** Automated test ([handlers](../../src/__tests__/routes/setup/handlers.test.ts))

**Status:** Implemented

---

### REQ-SETUP-007: Custom domain with DNS validation

**Intent:** The setup wizard must configure a custom domain with proper DNS records and Worker routes, supporting nested subdomains and ccTLDs.

**Applies To:** Admin

**Acceptance Criteria:**

1. Zone resolution walks progressively shorter suffixes of the requested hostname so multi-label TLDs are handled correctly. <!-- @impl: src/routes/setup/custom-domain.ts::handleConfigureCustomDomain --> <!-- @test: src/__tests__/setup-007-custom-domain-ac.test.ts (REQ-SETUP-007 AC1: zone resolution tries progressively shorter domain suffixes to support ccTLDs) -->
2. A proxied CNAME record is created or updated, pointing the custom domain at the Worker's default workers.dev hostname. <!-- @impl: src/routes/setup/custom-domain.ts::handleConfigureCustomDomain --> <!-- @test: src/__tests__/setup-007-custom-domain-ac.test.ts (REQ-SETUP-007 AC2: proxied CNAME record is created pointing custom domain to workers.dev target) -->
3. A Worker route covering the custom domain is created and mapped to the deployed Worker script. <!-- @impl: src/routes/setup/custom-domain.ts::handleConfigureCustomDomain --> <!-- @test: src/__tests__/setup-007-custom-domain-ac.test.ts (REQ-SETUP-007 AC3: Worker route pattern {customDomain}/* is created mapped to the worker script) -->
4. An already-existing Worker route succeeds only when its pattern and script are verified correct or its update succeeds; failed or unverified updates fail setup. <!-- @impl: src/routes/setup/custom-domain.ts::handleConfigureCustomDomain --> <!-- @test: src/__tests__/routes/setup/custom-domain.test.ts (accepts an already-existing worker route only when its current state is correct) --> <!-- @test: src/__tests__/routes/setup/custom-domain.test.ts (updates an already-existing worker route whose state is wrong) --> <!-- @test: src/__tests__/routes/setup/custom-domain.test.ts (fails setup when an incorrect worker route cannot be updated) -->
5. The custom domain is persisted in normalized (lowercased) form so origin comparisons are deterministic. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/setup-007-custom-domain-ac.test.ts (REQ-SETUP-007 AC5: custom domain is stored in KV as setup:custom_domain (lowercased)) -->
6. Dynamic origins (the custom domain plus any additional origins configured via setup) are cached in-memory for a short TTL; the persistent store is the source of truth. <!-- @impl: src/lib/cors-cache.ts::isAllowedOrigin --> <!-- @test: src/__tests__/lib/cors-cache.test.ts (cors-cache / REQ-SETUP-007 (custom-domain CORS cache invalidation)) -->
7. After setup completes, the workers.dev hostname is treated as an initialization-only fallback; production traffic flows through the custom domain. <!-- @impl: src/routes/setup/custom-domain.ts::handleConfigureCustomDomain --> <!-- @test: src/__tests__/setup-007-custom-domain-ac.test.ts (REQ-SETUP-007 AC2: proxied CNAME record is created pointing custom domain to workers.dev target) -->

**Constraints:**

- The custom-domain zone must be managed by Cloudflare for DNS provisioning to succeed.
- The CNAME record is Cloudflare-proxied so the origin address is not exposed.

**Priority:** P1

**Dependencies:** [REQ-SETUP-002](#req-setup-002-setup-wizard-configures-domain-auth-r2-credentials-and-turnstile)

**Verification:** Automated test ([Integration test](../../src/__tests__/setup-007-custom-domain-ac.test.ts))

**Status:** Implemented

---

### REQ-SETUP-008: Setup helper endpoints support prefill and detection

**Intent:** The setup UI must be able to pre-populate fields from existing configuration and detect the API token's capabilities.

**Applies To:** Admin

**Acceptance Criteria:**

1. The prefill endpoint reads existing CF Access group membership and persistent configuration so the setup form repopulates correctly on redeployment. <!-- @impl: src/routes/setup/handlers.ts::default --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (Setup Handlers / REQ-SETUP-005 (admin-only auth gate on POST setup endpoints) / REQ-SETUP-006 (setup config persistence + reload) / REQ-SETUP-008 (setup wizard step state machine and validation) / REQ-SETUP-011 (allowlist persisted as KV user records via setup endpoint)) -->
2. The token-detection endpoint validates the API token and returns its account info (id and name); it does not enumerate the token's permissions/scopes. <!-- @impl: src/routes/setup/handlers.ts::default --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (GET /detect-token) -->
3. Both helper endpoints share the same rate limiter as the configure endpoint, so they cannot bypass setup-route throttling. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (Setup Handlers / REQ-SETUP-005 (admin-only auth gate on POST setup endpoints) / REQ-SETUP-006 (setup config persistence + reload) / REQ-SETUP-008 (setup wizard step state machine and validation) / REQ-SETUP-011 (allowlist persisted as KV user records via setup endpoint)) -->
4. Both endpoints require admin auth after setup is complete, using the same conditional gate as the configure endpoint. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (Setup Handlers / REQ-SETUP-005 (admin-only auth gate on POST setup endpoints) / REQ-SETUP-006 (setup config persistence + reload) / REQ-SETUP-008 (setup wizard step state machine and validation) / REQ-SETUP-011 (allowlist persisted as KV user records via setup endpoint)) -->

**Constraints:**

- Prefill is read-only: it never writes to the Cloudflare API or persistent state.
- Token detection is a read-only validation and never provisions resources.

**Priority:** P1

**Dependencies:** [REQ-SETUP-005](#req-setup-005-post-setup-reconfiguration-requires-admin-auth)

**Verification:** Automated test ([handlers](../../src/__tests__/routes/setup/handlers.test.ts))

**Status:** Implemented

---

<a id="req-setup-009-saas-subscription-flow-and-ui"></a>
### REQ-SETUP-009: Subscribe page with tier selection

**Intent:** Users can choose their subscription tier with a clear comparison of features and pricing.

**Applies To:** User

**Acceptance Criteria:**

1. The subscribe page shows the available tiers with their features, included hours, session limits, storage, and pricing. <!-- @impl: web-ui/src/components/SubscribePage.tsx::SubscribePage --> <!-- @test: web-ui/src/__tests__/components/SubscribePage.test.tsx (SubscribePage / REQ-SETUP-009 (subscribe page redirect for pending users) / REQ-SUB-017 (tier selection UI)) -->
2. The flow is a two-phase wizard: an overview phase and a tier-selection phase; checkout is an external payment-provider handoff, not an internal phase. <!-- @impl: web-ui/src/components/SubscribePage.tsx::SubscribePage --> <!-- @test: web-ui/src/__tests__/components/SubscribePage.test.tsx (SubscribePage / REQ-SETUP-009 (subscribe page redirect for pending users) / REQ-SUB-017 (tier selection UI)) -->
3. New subscriptions are gated by a CAPTCHA challenge whose token is passed to and verified by the Worker before a paid checkout is created; missing/rejected tokens produce no Stripe call or user mutation, while active-subscriber plan switches remain exempt. <!-- @impl: web-ui/src/components/SubscribePage.tsx::SubscribePage --> <!-- @impl: src/routes/billing.ts::default --> <!-- @test: web-ui/src/__tests__/components/SubscribePage.test.tsx (REQ-SETUP-009 AC3: Turnstile CAPTCHA is initialized for pending users when turnstileSiteKey is provided) -->
4. The page exposes a mode toggle between the two subscription mode families. <!-- @impl: web-ui/src/components/SubscribePage.tsx::SubscribePage --> <!-- @test: web-ui/src/__tests__/components/SubscribePage.test.tsx (SubscribePage / REQ-SETUP-009 (subscribe page redirect for pending users) / REQ-SUB-017 (tier selection UI)) -->
5. The free tier activates immediately without an external checkout step. <!-- @impl: web-ui/src/components/SubscribePage.tsx::SubscribePage --> <!-- @test: web-ui/src/__tests__/components/SubscribePage.test.tsx (REQ-SETUP-009 AC5: free tier activates immediately via subscribe API call (no Stripe checkout)) -->
6. Paid tiers hand off to the external payment provider's hosted checkout. <!-- @impl: web-ui/src/components/SubscribePage.tsx::SubscribePage --> <!-- @test: web-ui/src/__tests__/components/SubscribePage.test.tsx (REQ-SETUP-009 AC6: paid tiers show "Start Trial" CTA indicating Stripe checkout path) -->

**Constraints:** None.

**Priority:** P1

**Dependencies:** [REQ-SUB-001](subscription.md#req-sub-001-eight-tier-subscription-system)

**Verification:** Automated test ([Integration test](../../web-ui/src/__tests__/components/SubscribePage.test.tsx))

**Status:** Implemented

---

### REQ-SETUP-010: Social-share preview metadata on the public landing page

**Intent:** When the public-facing URL is shared on social platforms or chat apps, the unfurl renders a branded preview card with the product tagline and a 1200x630 preview image so the link communicates what Codeflare is before the visitor clicks.

**Applies To:** User

**Acceptance Criteria:**

1. The home page exposes Open Graph metadata: `og:type`, `og:site_name`, `og:title`, `og:description`, `og:url`, `og:image`, `og:image:width=1200`, `og:image:height=630`, `og:image:alt`, `og:locale`. <!-- @impl: web-ui/index.html::og:image:alt --> <!-- @test: web-ui/src/__tests__/setup-010-og-metadata.test.ts (REQ-SETUP-010: Social-share preview metadata on the public landing page) -->
2. Twitter Card metadata is set with `twitter:card="summary_large_image"` plus title, description, image, and image:alt. <!-- @impl: web-ui/index.html::format-detection --> <!-- @test: web-ui/src/__tests__/setup-010-og-metadata.test.ts (AC2: Twitter Card metadata is set (scraper view)) -->
3. The preview image is a 1200x630 PNG that includes the Codeflare wordmark, the product tagline, and a CODEFLARE.CH wordmark footer. <!-- @test: web-ui/src/__tests__/setup-010-og-metadata.test.ts (AC3: 1200x630 PNG preview image is referenced (parsed values)) --> <!-- @manual -->
4. The `<meta name="description">` extends the `og:description` (it begins with the same canonical share copy and appends a short product descriptor) so search-engine snippets and social-share cards stay aligned. <!-- @test: web-ui/src/__tests__/setup-010-og-metadata.test.ts (REQ-SETUP-010: Social-share preview metadata on the public landing page) --> <!-- @manual -->

**Constraints:**

- The preview image must remain <=1MB so platforms cache it inline.
- og:image dimensions are 1200x630 (the dual standard for Open Graph and Twitter `summary_large_image` cards).

**Priority:** P2

**Dependencies:** None.

**Verification:** Automated test ([setup-010-og-metadata](../../web-ui/src/__tests__/setup-010-og-metadata.test.ts))

**Status:** Implemented

---

### REQ-SETUP-011: Setup stream completion payload contract

**Intent:** The terminal `done: true` object in the NDJSON stream must carry enough information for the client to render the final outcome and chain into post-setup flows (success URL display, lock-contention retry guidance, error surfacing).

**Applies To:** User

**Acceptance Criteria:**

1. Successful completion carries the same ordered, upserted per-step status list used by streamed transitions, plus the workers.dev URL and custom-domain URL. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @impl: src/routes/setup/shared.ts::upsertStep --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (keeps one immutable ordered status list across running, success, and failure transitions) -->
2. Failed completion carries that cumulative list including the failed step, plus a top-level error description. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @impl: src/routes/setup/shared.ts::upsertStep --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (keeps one immutable ordered status list across running, success, and failure transitions) -->
3. Lock contention produces an immediate terminal completion with success=false and no intervening step progress messages. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (Setup Handlers / REQ-SETUP-005 (admin-only auth gate on POST setup endpoints) / REQ-SETUP-006 (setup config persistence + reload) / REQ-SETUP-008 (setup wizard step state machine and validation) / REQ-SETUP-011 (allowlist persisted as KV user records via setup endpoint)) -->
4. Clients detect completion by parsing stream entries until the terminal completion marker, then read the success flag. <!-- @impl: web-ui/src/stores/setup.ts::setupStore --> <!-- @test: web-ui/src/__tests__/stores/setup.test.ts (Setup Store) -->

**Constraints:**

- The per-step status list in the completion object is cumulative across all attempted steps.

**Priority:** P1

**Dependencies:** [REQ-SETUP-006](#req-setup-006-setup-streams-progress-via-ndjson)

**Verification:** Automated test ([handlers](../../src/__tests__/routes/setup/handlers.test.ts))

**Status:** Implemented

---

### REQ-SETUP-012: Setup wizard step sequence

**Intent:** The setup wizard's canonical provisioning slots run in stable order when applicable. Each attempted slot has a stable NDJSON identifier and independently enforced observable effect; mode-specific omission or extension does not fabricate placeholder frontend steps.

**Applies To:** Admin

**Acceptance Criteria:**

1. Step 1 retrieves the Cloudflare account ID from the API token. <!-- @impl: src/routes/setup/account.ts::handleGetAccount --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-012 AC1: step get_account retrieves account ID from the API token) -->
2. Step 2 derives R2-compatible credentials deterministically from the API token. <!-- @impl: src/routes/setup/credentials.ts::handleDeriveR2Credentials --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-012 AC2: step derive_r2_credentials uses token ID as Access Key ID and SHA-256 of token as Secret) -->
3. Step 3 stores the R2 access credentials as Worker secrets. <!-- @impl: src/routes/setup/secrets.ts::handleSetSecrets --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-012 AC3: step set_secrets sets R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY as Worker secrets) -->
4. Reconfiguration never initiates user offboarding or removes user credentials, sessions, control state, or storage based on absence from the submitted allowlist. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-012 AC4: reconfiguration never offboards a user absent from the submitted allowlist) -->
5. Step 4 configures the custom domain by upserting the DNS record and Worker route. <!-- @impl: src/routes/setup/custom-domain.ts::handleConfigureCustomDomain --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-012 AC5: step configure_custom_domain creates CNAME DNS record and Worker route) -->
6. Step 5 upserts the CF Access application, groups, and policies; this step is bypassed when an OAuth client ID is configured (the SaaS OAuth path per AD38), not unconditionally in SaaS mode. <!-- @impl: src/routes/setup/access.ts::handleCreateAccessApp --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-012 AC6: step create_access_app creates CF Access application and is skipped in GitHub OIDC mode) -->
7. Enterprise extension steps retain source order without reordering applicable canonical slots. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (Setup AC Coverage) -->

**Constraints:**

- Canonical slot ordering is fixed; conditional slots may be absent, and named extension steps may not reorder the applicable canonical slots.

**Priority:** P0

**Dependencies:** [REQ-SETUP-002](#req-setup-002-setup-wizard-configures-domain-auth-r2-credentials-and-turnstile)

**Verification:** Automated test ([setup-ac-coverage](../../src/__tests__/setup-ac-coverage.test.ts))

**Status:** Implemented

---

### REQ-SETUP-013: Managed environment configuration

**Intent:** An administrator can configure one verified managed environment for every deployment mode without disturbing user data.

**Applies To:** Admin

**Acceptance Criteria:**

1. Every deployment mode accepts an optional repository, scoped read token, verification key, and enabled state. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/routes/setup-managed-environment.test.ts (REQ-SETUP-013 AC1: every deployment mode accepts the managed-environment boundary) -->
2. A blank token replacement preserves the stored repository credential. <!-- @impl: src/lib/remote-curation.ts::configureManagedEnvironment --> <!-- @test: src/__tests__/lib/remote-curation.test.ts (stores the PAT only as AES ciphertext and transactionally activates monotonic public-key replacement) -->
3. Enablement, repository replacement, or public-key replacement selects a candidate only after its cache namespace contains a complete verified release. <!-- @impl: src/lib/remote-curation.ts::configureManagedEnvironment --> <!-- @test: src/__tests__/lib/remote-curation.test.ts (stores the PAT only as AES ciphertext and transactionally activates monotonic public-key replacement) -->
4. Candidate failure preserves the prior selected configuration and active release. <!-- @impl: src/lib/remote-curation.ts::configureManagedEnvironment --> <!-- @test: src/__tests__/lib/remote-curation.test.ts (stores the PAT only as AES ciphertext and transactionally activates monotonic public-key replacement) -->
5. Public-key replacement is selected only after its signed release verifies without rolling back or conflicting with the active sequence. <!-- @impl: src/lib/remote-curation.ts::configureManagedEnvironment --> <!-- @test: src/__tests__/lib/remote-curation.test.ts (stores the PAT only as AES ciphertext and transactionally activates monotonic public-key replacement) -->
6. Disabling retains verified history and schedules baked convergence without invoking user offboarding or destructive cleanup. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/routes/setup-managed-environment.test.ts (REQ-SETUP-013 AC6: disabling curation does not offboard users or delete cache history) -->
7. Public Setup payloads cannot write applied release, path-digest, mode, or interceptor state. <!-- @impl: src/routes/setup/index.ts::ConfigureBodySchema --> <!-- @test: src/__tests__/routes/setup-managed-environment.test.ts (REQ-SETUP-013 AC7: rejects applied and interceptor state injection) -->

**Constraints:**

- Setup cannot infer offboarding from omitted users.
- Production signing keys remain outside Codeflare.
- The user-facing label is “Managed Environment.”

**Priority:** P1

**Dependencies:** [REQ-SETUP-005](#req-setup-005-post-setup-reconfiguration-requires-admin-auth), [REQ-SETUP-012](#req-setup-012-setup-wizard-step-sequence), [REQ-SETUP-014](#req-setup-014-managed-repository-credential-boundary), [REQ-AGENT-147](agents.md#req-agent-147-signed-managed-agent-configuration-releases), [REQ-AGENT-148](agents.md#req-agent-148-protected-managed-release-publication)

**Verification:** Automated Setup-route, payload-boundary, and transactional trust tests

**Status:** Implemented

---

### REQ-SETUP-014: Managed repository credential boundary

**Intent:** Managed-release repository credentials remain confined to the Worker trust boundary.

**Applies To:** Admin

**Acceptance Criteria:**

1. Repository credentials are stored only through the existing confidential KV boundary. <!-- @impl: src/lib/remote-curation.ts::configureManagedEnvironment --> <!-- @test: src/__tests__/lib/remote-curation.test.ts (stores the PAT only as AES ciphertext and transactionally activates monotonic public-key replacement) -->
2. Prefill returns only bounded non-secret managed-environment status. <!-- @impl: src/lib/remote-curation.ts::getManagedEnvironmentPrefill --> <!-- @test: src/__tests__/routes/setup-managed-environment.test.ts (REQ-SETUP-014 AC2: prefill returns bounded status without PAT bytes) -->
3. Repository authorization is rejected before transmission when an asset URL does not use GitHub's API host. <!-- @impl: src/lib/remote-curation.ts::downloadManagedAsset --> <!-- @test: src/__tests__/lib/remote-curation.test.ts (REQ-SETUP-014 AC3: rejects a non-GitHub API origin before sending repository authorization) -->
4. Release asset authorization is removed before every allowed redirect. <!-- @impl: src/lib/remote-curation.ts::downloadManagedAsset --> <!-- @test: src/__tests__/lib/remote-curation.test.ts (downloads one exact allowed redirect without forwarding GitHub authorization) --> <!-- @test: src/__tests__/lib/remote-curation.test.ts (rejects an asset redirect outside the fixed GitHub object hosts) -->
5. Persisted managed-release diagnostics redact repository credentials. <!-- @impl: src/lib/remote-curation.ts::safeError --> <!-- @test: src/__tests__/lib/remote-curation.test.ts (REQ-SETUP-014 AC5: degraded diagnostics redact repository credentials) -->
6. User storage receives only verified release documents, never repository credentials. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-SETUP-014 AC6: configured repository credentials never enter user-bucket writes) -->
7. Container environments never receive managed repository credentials. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/container/container-env.test.ts (REQ-SETUP-014 AC7: never emits managed repository credentials into the container environment) -->

**Constraints:**

- Production signing credentials remain outside Codeflare.
- Repository credentials never enter logs.

**Priority:** P1

**Dependencies:** [REQ-SETUP-005](#req-setup-005-post-setup-reconfiguration-requires-admin-auth), [REQ-AGENT-147](agents.md#req-agent-147-signed-managed-agent-configuration-releases)

**Verification:** Automated credential storage, prefill, host, redirect, diagnostic, storage, and container-boundary tests

**Status:** Implemented

---

### REQ-SETUP-015: Managed-resource persistence controls

**Intent:** Enterprise Setup presents and normalizes managed-resource persistence controls without losing stored selection.

**Applies To:** Enterprise

**Acceptance Criteria:**

1. Enterprise Setup exposes nested Immutable Resources and Disable User Created Resources controls. <!-- @impl: web-ui/src/components/setup/ManagedEnvironmentSection.tsx::ManagedEnvironmentSection --> <!-- @test: web-ui/src/__tests__/components/ManagedEnvironmentSection.test.tsx (REQ-SETUP-015 AC1: renders nested immutable resource controls) -->
2. Explicit control values normalize to `mutable`, `immutable`, or `exclusive`. <!-- @impl: src/lib/remote-curation.ts::resolveManagedResourcePolicy --> <!-- @test: src/__tests__/lib/remote-curation.test.ts (REQ-SETUP-015 AC2: normalizes explicit managed resource controls) -->
3. Clearing Immutable Resources also clears Disable User Created Resources. <!-- @impl: web-ui/src/stores/setup.ts::setManagedEnvironmentImmutableResources --> <!-- @test: web-ui/src/__tests__/stores/setup-managed-environment.test.ts (REQ-SETUP-015 AC3: clearing immutable resources clears exclusive mode) -->
4. Omitted policy controls preserve the stored selection. <!-- @impl: src/lib/remote-curation.ts::resolveManagedResourcePolicy --> <!-- @test: src/__tests__/lib/remote-curation.test.ts (REQ-SETUP-015 AC4: omitted managed resource controls preserve stored policy) -->
5. Omitted policy controls default to mutable when no prior configuration exists. <!-- @impl: src/lib/remote-curation.ts::resolveManagedResourcePolicy --> <!-- @test: src/__tests__/lib/remote-curation.test.ts (REQ-SETUP-015 AC5: omitted managed resource controls default to mutable) -->
6. Setup describes selected-mode persistence and rolling activation in concise user terms. <!-- @impl: web-ui/src/components/setup/ManagedEnvironmentSection.tsx::ManagedEnvironmentSection --> <!-- @test: web-ui/src/__tests__/components/ManagedEnvironmentSection.test.tsx (REQ-SETUP-015 AC6: describes the selected managed-resource mode) -->

**Constraints:** Public payloads cannot select applied or interceptor state.

**Priority:** P0

**Dependencies:** [REQ-SETUP-013](#req-setup-013-managed-environment-configuration)

**Verification:** Automated Setup UI, normalization, parent-child, and stored-state tests

**Status:** Implemented

---

### REQ-SETUP-016: Managed-resource policy safety

**Intent:** Enterprise policy selection validates prerequisites and rolls out safely per idle user bucket.

**Applies To:** Enterprise

**Acceptance Criteria:**

1. Exclusive policy is rejected unless immutable policy is selected. <!-- @impl: src/lib/remote-curation.ts::resolveManagedResourcePolicy --> <!-- @test: src/__tests__/lib/remote-curation.test.ts (REQ-SETUP-016 AC1: rejects exclusive policy without immutable policy) -->
2. Protected policy is rejected unless Enterprise Strict Gateway Egress is available. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/routes/setup-managed-environment.test.ts (REQ-SETUP-016 AC2: rejects unavailable protected policy before streaming) --> <!-- @test: src/__tests__/routes/setup-managed-environment.test.ts (REQ-SETUP-016 AC2: rejects disabling strict egress while stored policy remains protected) -->
3. Setup stores a changed desired policy without scanning or draining deployment-wide sessions. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/routes/setup-managed-environment.test.ts (REQ-SETUP-016 AC3: stores a rolling desired policy without scanning deployment-wide sessions) -->
4. A running user session prevents reconciliation, retaining that user's applied policy. <!-- @impl: src/routes/storage/seed.ts::default --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (returns a typed 409 before bucket creation or R2 writes when any session is running) -->
5. New starts wait on desired/applied policy mismatch until reconciliation completes. <!-- @impl: src/routes/container/lifecycle.ts::app --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (blocks a desired and applied resource-policy mismatch before bucket work) -->
6. Storage mutations wait on desired/applied policy mismatch until reconciliation completes. <!-- @impl: src/lib/managed-storage-guard.ts::guardManagedStorageMutation --> <!-- @test: src/__tests__/lib/managed-storage-guard.test.ts (fails update-pending before policy lookup on %s mismatch) -->
7. Policy selection preserves repository, signing-key, release-cache, and sequence fingerprints. <!-- @impl: src/lib/remote-curation.ts::configureManagedEnvironment --> <!-- @test: src/__tests__/lib/remote-curation.test.ts (stores the PAT only as AES ciphertext and transactionally activates monotonic public-key replacement) -->

**Constraints:** Policy safety checks run before configuration writes.

**Priority:** P0

**Dependencies:** [REQ-SETUP-015](#req-setup-015-managed-resource-persistence-controls), [REQ-ENTERPRISE-016](enterprise-mode.md#req-enterprise-016-strict-gateway-egress)

**Verification:** Automated policy-shape, availability, rolling-activation, update-pending, reconciliation, and trust-fingerprint tests

**Status:** Implemented

---

### REQ-SETUP-017: Mode-aware Administration configuration read

**Intent:** Administrators need one authoritative routine-settings response without rerunning first-time provisioning.

**Applies To:** Admin

**Acceptance Criteria:**

1. `GET /api/admin/configuration` requires shared authentication and administrator authorization in every deployment mode. <!-- @impl: src/routes/admin/configuration.ts::app --> <!-- @test: src/__tests__/routes/admin-configuration.test.ts (rejects unauthenticated and non-admin requests) -->
2. The response returns effective mode, revision, applicable closed sections, non-secret values, active run identity, and direct latest terminal summaries. <!-- @impl: src/routes/admin/configuration.ts::app --> <!-- @impl: src/lib/admin-configuration.ts::applicableConfigurationSections --> <!-- @test: src/__tests__/routes/admin-configuration.test.ts (returns one non-enterprise mode contract for %s) --> <!-- @test: src/__tests__/routes/admin-configuration.test.ts (prefers Administration secret state and reads direct latest summaries without listing Activity) -->
3. Secret fields return only `administration`, `deployment`, or `none`; no secret bytes, expiry claims, or submitted values are returned. <!-- @impl: src/routes/admin/configuration.ts::secretState --> <!-- @test: src/__tests__/routes/admin-configuration.test.ts (returns enterprise credential sources without exposing secret bytes) -->
4. Enterprise AI Gateway reports effective URL and API-token source, resolving Administration values independently before deployment fallbacks. <!-- @impl: src/routes/admin/configuration.ts::app --> <!-- @test: src/__tests__/routes/admin-configuration.test.ts (returns enterprise credential sources without exposing secret bytes) --> <!-- @test: src/__tests__/routes/admin-configuration.test.ts (prefers Administration secret state and reads direct latest summaries without listing Activity) -->
5. Browser Run remains optional with no enable flag: no stored pair is valid, while a configured state requires account ID plus saved token. <!-- @impl: src/routes/admin/configuration.ts::app --> <!-- @test: src/__tests__/routes/admin-configuration.test.ts (returns enterprise credential sources without exposing secret bytes) --> <!-- @test: src/__tests__/routes/admin-configuration.test.ts (prefers Administration secret state and reads direct latest summaries without listing Activity) -->
6. Default, Onboarding, and SaaS preserve existing Users behavior; SaaS preserves Subscription Tiers; Enterprise continues rejecting both backend resources. <!-- @impl: src/routes/users.ts::app --> <!-- @impl: src/routes/admin/tiers.ts::app --> <!-- @test: src/__tests__/routes/enterprise-route-hardening.test.ts (REQ-ENTERPRISE-009 AC1: /api/users fails closed in enterprise mode) --> <!-- @test: src/__tests__/routes/enterprise-route-hardening.test.ts (REQ-ENTERPRISE-009 AC5: admin tier config routes 403 in enterprise mode) -->

**Constraints:** Reuse Setup readers and existing mode owners. Configuration reads do not list Activity records.

**Priority:** P0

**Dependencies:** [REQ-SETUP-005](#req-setup-005-post-setup-reconfiguration-requires-admin-auth), [REQ-ENTERPRISE-017](enterprise-mode.md#req-enterprise-017-ai-gateway-configured-in-the-setup-wizard), [REQ-BROWSER-007](browser-run.md#req-browser-007-enterprise-admin-configured-browser-rendering-token)

**Verification:** Automated route and mode-hardening tests

**Status:** Implemented

---

### REQ-SETUP-018: Stateless Environment preview and bounded execution

**Intent:** An administrator can review and apply one known Environment area without rerunning unrelated Setup work.

**Applies To:** Admin

**Acceptance Criteria:**

1. Preview accepts one closed section, complete values, and base revision; it persists nothing and returns normalized changes, exact tasks, warnings, and exclusions. <!-- @impl: src/routes/admin/configuration-previews.ts::default --> <!-- @impl: src/lib/admin-configuration.ts::buildConfigurationPreview --> <!-- @test: src/__tests__/routes/admin-configuration-preview.test.ts (POST /admin/configuration-previews (REQ-SETUP-018)) -->
2. Apply recomputes validation, uses best-effort KV admission, rechecks revision before external work, and returns typed `409` conflicts before streaming. <!-- @impl: src/routes/admin/configuration-runs.ts::default --> <!-- @test: src/__tests__/routes/admin-configuration-runs.test.ts (configuration runs (REQ-SETUP-018)) -->
3. Runs persist sanitized versioned state, named task transitions, initiator, revisions, and terminal outcomes for 90 days; values and secrets never enter records, streams, or logs. <!-- @impl: src/routes/admin/configuration-runs.ts::default --> <!-- @test: src/__tests__/routes/admin-configuration-runs.test.ts (configuration runs (REQ-SETUP-018)) -->
4. Reconnect returns the same run shape, and Activity lists newest-first with a stable cursor. <!-- @impl: src/routes/admin/configuration-runs.ts::default --> <!-- @test: src/__tests__/routes/admin-configuration-runs.test.ts (configuration runs (REQ-SETUP-018)) -->
5. Task failure stops dependent work, marks remaining tasks skipped, records operator action, and never performs automatic rollback or replay. <!-- @impl: src/routes/admin/configuration-runs.ts::default --> <!-- @test: src/__tests__/routes/admin-configuration-runs.test.ts (configuration runs (REQ-SETUP-018)) -->
6. A stale 15-minute active pointer is recovered as `interrupted`; the accepted cross-isolate KV race remains bounded by idempotent operations and revision checks. <!-- @impl: src/routes/admin/configuration-runs.ts::recoverInterruptedRun --> <!-- @test: src/__tests__/routes/admin-configuration-runs.test.ts (configuration runs (REQ-SETUP-018)) -->
7. Setup and routine execution check each other's existing admission pointers, while first-run `POST /api/setup/configure` keeps its observable sequence and outcome. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @impl: src/routes/admin/configuration-runs.ts::default --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-018 AC7: Setup refuses to overlap an active Environment run) -->

**Constraints:** Eleven known sections use one discriminated union. No JSON Patch, stored preview, workflow engine, coordinator Durable Object, or generic rollback layer.

**Priority:** P0

**Dependencies:** [REQ-SETUP-004](#req-setup-004-setup-is-idempotent), [REQ-SETUP-006](#req-setup-006-setup-streams-progress-via-ndjson), [REQ-SETUP-017](#req-setup-017-mode-aware-administration-configuration-read)

**Verification:** Automated request, persistence, conflict, redaction, executor-boundary, and first-run compatibility tests

**Status:** Implemented

---

### REQ-SETUP-019: Administration and Analytics shell

**Intent:** First-run provisioning and routine administration use one coherent mode-aware operator experience while Setup remains the bootstrap orchestrator.

**Applies To:** Admin

**Acceptance Criteria:**

1. The shell exposes `/admin`, `/admin/environment`, `/admin/analytics`, `/admin/reports`, and `/admin/activity`; no user-facing `/admin/configuration` route exists. <!-- @impl: web-ui/src/App.tsx::App --> <!-- @impl: web-ui/src/components/admin/AdministrationLayout.tsx::AdministrationLayout -->
2. Default and Onboarding add Users; SaaS adds Users and Subscription Tiers; Enterprise exposes neither. <!-- @impl: web-ui/src/components/admin/AdministrationLayout.tsx::AdministrationLayout -->
3. Existing Users and Subscription components and APIs are embedded without changing their mutations. <!-- @impl: web-ui/src/App.tsx::AdministrationUsers --> <!-- @impl: web-ui/src/App.tsx::AdministrationSubscriptions -->
4. User-facing routine copy says Environment; Configuration remains internal API and storage vocabulary. <!-- @impl: web-ui/src/components/admin/EnvironmentIndex.tsx::EnvironmentIndex --> <!-- @impl: web-ui/src/components/SettingsPanel.tsx::SettingsPanel -->
5. Loading, empty, failure, conflict, reconnect, and responsive states follow the approved Administration and Analytics design contract. <!-- @impl: web-ui/src/components/admin/AdministrationLayout.tsx::AdministrationLayout --> <!-- @impl: web-ui/src/components/admin/EnvironmentIndex.tsx::EnvironmentAreaDetail --> <!-- @impl: web-ui/src/components/admin/AnalyticsPage.tsx::AnalyticsPage --> <!-- @impl: web-ui/src/components/admin/ReportsPage.tsx::ReportsPage --> <!-- @impl: web-ui/src/components/admin/ActivityPage.tsx::ActivityPage --> <!-- @impl: web-ui/src/styles/administration.css::.admin-shell --> <!-- @manual -->
6. First-run Setup presents mode-applicable readiness, access, routing, platform, managed-environment, integration, review, apply, and result stages. <!-- @impl: web-ui/src/components/setup/SetupWizard.tsx::SetupWizard --> <!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx::ConfigureStep --> <!-- @manual -->
7. Completed deployments expose bootstrap recovery through Administration instead of duplicating the action in workspace settings. <!-- @impl: web-ui/src/components/admin/AdministrationLayout.tsx::AdministrationLayout --> <!-- @impl: web-ui/src/components/SettingsPanel.tsx::SettingsPanel --> <!-- @manual -->

**Constraints:** One authoritative response owns mode gating. No UI framework, chart package, icon package, or duplicate mode logic is added.

**Priority:** P1

**Dependencies:** [REQ-SETUP-017](#req-setup-017-mode-aware-administration-configuration-read), [REQ-AUTH-018](authentication.md#req-auth-018-admin-user-management), [REQ-SUB-009](subscription.md#req-sub-009-admin-tier-management)

**Verification:** Automated backend mode gates and user-owned manual UI acceptance on Integration

**Status:** Implemented

---

### REQ-SETUP-020: Administration report timezone selection

**Intent:** An administrator can select a report timezone without losing an accepted deployed schedule value.

**Applies To:** Admin

**Acceptance Criteria:**

1. Administration presents report timezones as a dropdown populated with canonical IANA choices. <!-- @impl: web-ui/src/components/admin/EnvironmentAreaFields.tsx::EnvironmentAreaFields --> <!-- @test: web-ui/src/__tests__/components/EnvironmentAreaFields.test.tsx (REQ-SETUP-020 AC1: renders canonical IANA timezone choices as a select) -->
2. An accepted stored timezone remains selected when it is absent from the bundled choices. <!-- @impl: web-ui/src/lib/iana-timezones.ts::ianaTimezoneOptions --> <!-- @test: web-ui/src/__tests__/lib/iana-timezones.test.ts (REQ-SETUP-020 AC2: preserves accepted stored timezone values) --> <!-- @test: web-ui/src/__tests__/components/EnvironmentAreaFields.test.tsx (REQ-SETUP-020 AC2: retains an accepted stored timezone outside bundled choices) -->

**Constraints:** Backend report-setting validation remains authoritative.

**Priority:** P1

**Dependencies:** [REQ-SUB-027](subscription.md#req-sub-027-monthly-organization-usage-reports), [REQ-SETUP-018](#req-setup-018-stateless-environment-preview-and-bounded-execution)

**Verification:** Automated timezone-option behavior and user-owned manual UI acceptance on Integration

**Status:** Implemented

---

### REQ-SETUP-021: Administration managed-environment status

**Intent:** Administration reports the deployed managed-environment state without confusing configuration with release freshness.

**Applies To:** Admin

**Acceptance Criteria:**

1. Managed-environment summaries distinguish configured release, configured-disabled, and unconfigured states. <!-- @impl: web-ui/src/components/admin/environment-areas.ts::environmentAreas --> <!-- @test: web-ui/src/__tests__/components/environment-areas.test.ts (REQ-SETUP-021 AC1: reports configured, disabled, and unconfigured managed-environment states) -->

**Constraints:** The authoritative managed-environment prefill remains the status source.

**Priority:** P1

**Dependencies:** [REQ-SETUP-013](#req-setup-013-managed-environment-configuration), [REQ-SETUP-017](#req-setup-017-mode-aware-administration-configuration-read)

**Verification:** Automated summary-state mapping and user-owned manual UI acceptance on Integration

**Status:** Implemented

---

### REQ-SETUP-022: Initialization presentation and hydration

**Intent:** Administrators can identify Initialization and cannot mistake unloaded recovery defaults for deployed configuration.

**Applies To:** Admin

**Acceptance Criteria:**

1. Administration labels its bootstrap-recovery entry Initialization. <!-- @impl: web-ui/src/components/admin/AdministrationLayout.tsx::AdministrationLayout --> <!-- @manual -->
2. A configured deployment keeps recovery hidden until existing values load, then shows Completed status with its effective deployment mode. <!-- @impl: web-ui/src/components/setup/SetupWizard.tsx::SetupWizard --> <!-- @impl: web-ui/src/stores/setup.ts::loadExistingConfig --> <!-- @test: web-ui/src/__tests__/components/SetupWizard.test.tsx (REQ-SETUP-022 AC2: hydrates completed Enterprise initialization before rendering recovery) -->
3. Failed configured-deployment hydration shows a retryable load error without rendering recovery defaults. <!-- @impl: web-ui/src/components/setup/SetupWizard.tsx::SetupWizard --> <!-- @impl: web-ui/src/stores/setup.ts::loadExistingConfig --> <!-- @test: web-ui/src/__tests__/components/SetupWizard.test.tsx (REQ-SETUP-022 AC3: keeps configured recovery closed when hydration fails) --> <!-- @test: web-ui/src/__tests__/stores/setup.test.ts (REQ-SETUP-022 AC3: reports hydration failure and permits retry) --> <!-- @test: web-ui/src/__tests__/stores/setup.test.ts (REQ-SETUP-022 AC3: keeps configured recovery closed when provider prefill fails) -->
4. Configured recovery offers Review initialization. <!-- @impl: web-ui/src/components/setup/SetupWizard.tsx::SetupWizard --> <!-- @impl: web-ui/src/components/setup/WelcomeStep.tsx::WelcomeStep --> <!-- @test: web-ui/src/__tests__/components/SetupWizard.test.tsx (REQ-SETUP-022 AC4: labels configured recovery as initialization review) -->
5. Unconfigured first-run offers Start setup. <!-- @impl: web-ui/src/components/setup/SetupWizard.tsx::SetupWizard --> <!-- @impl: web-ui/src/components/setup/WelcomeStep.tsx::WelcomeStep --> <!-- @test: web-ui/src/__tests__/components/SetupWizard.test.tsx (REQ-SETUP-022 AC5: retains the first-run setup action) -->

**Constraints:** First-run Setup remains best-effort before any deployed configuration exists.

**Priority:** P1

**Dependencies:** [REQ-SETUP-005](#req-setup-005-post-setup-reconfiguration-requires-admin-auth), [REQ-SETUP-019](#req-setup-019-administration-and-analytics-shell)

**Verification:** Automated hydration-order, recovery-action, and failure-state behavior plus user-owned manual UI acceptance on Integration

**Status:** Implemented

---

### REQ-SETUP-023: Environment catalog filtering

**Intent:** Administrators can narrow the loaded Environment catalog without adding another configuration read path.

**Applies To:** Admin

**Acceptance Criteria:**

1. Loaded Environment areas filter case-insensitively by label, area description, and current summary. <!-- @impl: web-ui/src/components/admin/environment-areas.ts::filterEnvironmentAreas --> <!-- @test: web-ui/src/__tests__/components/environment-areas.test.ts (REQ-SETUP-023 AC1: filters loaded areas by label, description, and current summary) -->
2. A query with no matching loaded area shows an empty result. <!-- @impl: web-ui/src/components/admin/EnvironmentIndex.tsx::EnvironmentIndex --> <!-- @manual -->

**Constraints:** Filtering stays client-side over the authoritative loaded response. It adds no request, index, or persisted search state.

**Priority:** P1

**Dependencies:** [REQ-SETUP-017](#req-setup-017-mode-aware-administration-configuration-read), [REQ-SETUP-019](#req-setup-019-administration-and-analytics-shell)

**Verification:** Automated filtering behavior and user-owned manual empty-result acceptance on Integration

**Status:** Implemented

---
