<a id="setup"></a>
# Setup & Administration

First-time setup wizard, deployment modes, custom domain configuration, bootstrap recovery, and routine Administration editing. Setup orchestrates provisioning; Administration owns mode-aware configuration reads, bounded Environment edits, and the operator-facing shell.

**Domain owner:** Worker (src/routes/setup/, src/routes/admin/), Cloudflare API integration, Administration web UI

### Key Concepts

| Concept | Definition |
|---------|-----------|
| Setup Wizard | A multi-step provisioning endpoint that creates all required Cloudflare resources (R2 credentials, DNS, Access apps, Turnstile) from a single API call |
| Deployment Mode | One of three runtime configurations: Default (CF Access auth), Onboarding (CF Access + public waitlist), or SaaS (GitHub OAuth + self-serve subscriptions) |
| NDJSON Streaming | The progress reporting format used by the setup endpoint -- each line is a self-contained JSON object with step name and status, ending with a `done: true` completion object |

### Out of Scope

- **Multi-region deployment** -- Codeflare deploys to a single Cloudflare Worker. No multi-region failover, geo-routing, or region-aware configuration in the setup wizard.
- **Automated scaling configuration** -- Container instance limits and resource tiers are set via GitHub Actions variables, not through the setup wizard. No auto-scaling policies.
- **Routing authority** -- Models & Routing owns model/profile identity, verification authority, runtime translation, and route eligibility; the records here retain the administrative editing and presentation contracts.
- **Identity, enforcement, and persistence authority** -- Authentication owns principal authentication and authorization; Security owns enforcement and strict egress; Storage owns storage isolation and mutation guarantees. Bootstrap and Administration editing do not replace those owners.

### Domain Dependencies

| Domain | Dependency |
|--------|-----------|
| Authentication | Setup wizard creates CF Access applications, groups, and policies; configures GitHub OAuth client in SaaS mode |
| Security | Turnstile CAPTCHA widget provisioned during setup for onboarding and SaaS landing pages; rate limiting on setup endpoints |
| Models & Routing | AI Gateway routing, immutable profiles, verification authority, and runtime eligibility |
| Storage | Managed-resource reconciliation and protected storage mutations |

---

### REQ-SETUP-001: First-time setup requires zero pre-configuration

**Intent:** A freshly deployed Codeflare instance must be configurable through the setup wizard without any prior manual setup of authentication, DNS, or storage.

**Applies To:** Admin

**Acceptance Criteria:**

1. Before setup completes, the setup-configure endpoint is publicly accessible (no authentication required). <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-001 AC1: POST /api/setup/configure is publicly accessible when setup:complete is not set in KV) -->
2. The deployer needs only a Cloudflare API token configured as a Worker secret; no other pre-configuration is required. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (Setup AC Coverage) -->
3. The Cloudflare API token is read from a Worker environment binding, not from the request body. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-001 AC3: CLOUDFLARE_API_TOKEN is read from environment binding not from request body) -->
4. The setup wizard provisions all necessary Cloudflare resources (R2 credentials, DNS records, Access applications, Turnstile widgets) from scratch. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-001 AC4: setup wizard creates R2 credentials, DNS records, and Access app resources) -->
5. The setup-status endpoint is always public and returns the configured flag, optional custom domain, and SaaS, Enterprise, and Onboarding mode flags. <!-- @impl: src/routes/setup/handlers.ts::default --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-001 AC5: GET /api/setup/status is always public and returns configured, customDomain, saasMode shape) --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (REQ-SETUP-001 AC5: returns onboarding mode from the deployment flag) -->

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
6. Storage mutations that may affect managed resources wait on desired/applied policy mismatch until reconciliation completes. <!-- @impl: src/lib/managed-storage-guard.ts::guardManagedStorageMutation --> <!-- @test: src/__tests__/lib/managed-storage-guard.test.ts (fails update-pending before policy lookup on %s mismatch) -->
7. Policy selection preserves repository, signing-key, release-cache, and sequence fingerprints. <!-- @impl: src/lib/remote-curation.ts::configureManagedEnvironment --> <!-- @test: src/__tests__/lib/remote-curation.test.ts (stores the PAT only as AES ciphertext and transactionally activates monotonic public-key replacement) -->

**Constraints:** Policy safety checks run before configuration writes.

**Priority:** P0

**Dependencies:** [REQ-SETUP-015](#req-setup-015-managed-resource-persistence-controls), [REQ-ENTERPRISE-016](security.md#req-enterprise-016-strict-gateway-egress)

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

**Dependencies:** [REQ-SETUP-005](#req-setup-005-post-setup-reconfiguration-requires-admin-auth), [REQ-ENTERPRISE-017](setup.md#req-enterprise-017-ai-gateway-configured-in-the-setup-wizard), [REQ-BROWSER-007](browser-run.md#req-browser-007-enterprise-admin-configured-browser-rendering-token)

**Verification:** Automated route and mode-hardening tests

**Status:** Implemented

---

### REQ-SETUP-027: Native target configuration projection

**Intent:** Administration reloads saved native targets without exposing provider authority or hiding unrelated configuration.

**Applies To:** Admin

**Acceptance Criteria:**

1. A valid saved native target reloads through the sanitized Administration configuration projection. <!-- @impl: src/routes/admin/configuration.ts::app --> <!-- @impl: src/lib/admin-configuration.ts::readNativeTargetViews --> <!-- @test: src/__tests__/routes/admin-configuration.test.ts (reloads a persisted native target through the sanitized Administration projection) -->
2. Absent native-target storage yields an empty projection. <!-- @impl: src/lib/admin-configuration.ts::readNativeTargetViews --> <!-- @test: src/__tests__/routes/admin-configuration.test.ts (does not call provider management when no native targets are saved) -->
3. Malformed native-target storage yields an empty projection. <!-- @impl: src/lib/admin-configuration.ts::readNativeTargetViews --> <!-- @test: src/__tests__/routes/admin-configuration.test.ts (keeps configuration available when persisted native targets are malformed) -->
4. Failure to read native-target storage fails the authoritative configuration request rather than appearing as an empty catalog. <!-- @impl: src/lib/admin-configuration.ts::readNativeTargetViews --> <!-- @test: src/__tests__/routes/admin-configuration.test.ts (fails closed when persisted native-target storage cannot be read) -->

**Constraints:** Raw provider configuration identity remains Worker-only.

**Priority:** P0

**Dependencies:** [REQ-SETUP-017](#req-setup-017-mode-aware-administration-configuration-read), [REQ-ENTERPRISE-053](models-and-routing.md#req-enterprise-053-native-target-identity-and-document)

**Verification:** Automated Administration configuration route tests

**Status:** Implemented

---

<a id="req-setup-018-bounded-routine-environment-changes"></a>
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

1. The shell exposes `/admin`, `/admin/environment`, `/admin/analytics`, `/admin/reports`, and `/admin/activity`; no user-facing `/admin/configuration` route exists. <!-- @impl: web-ui/src/App.tsx::App --> <!-- @impl: web-ui/src/components/admin/AdministrationLayout.tsx::AdministrationLayout --> <!-- @test: web-ui/src/__tests__/components/App.test.tsx (REQ-SETUP-019 AC1: exposes Administration routes) -->
2. Default and Onboarding add Users; SaaS adds Users and Subscription Tiers; Enterprise exposes neither. <!-- @impl: web-ui/src/components/admin/AdministrationLayout.tsx::AdministrationLayout --> <!-- @test: web-ui/src/__tests__/components/AdministrationLayout.test.tsx (REQ-SETUP-019 AC2: gates navigation by deployment mode) -->
3. Existing Users and Subscription Tiers components are embedded in their Administration routes. <!-- @impl: web-ui/src/App.tsx::AdministrationUsers --> <!-- @impl: web-ui/src/App.tsx::AdministrationSubscriptions --> <!-- @test: web-ui/src/__tests__/components/App.test.tsx (REQ-SETUP-019 AC3: embeds existing administration components) -->
4. User-facing routine copy says Environment; Configuration remains internal API and storage vocabulary. <!-- @impl: web-ui/src/components/admin/EnvironmentIndex.tsx::EnvironmentIndex --> <!-- @impl: web-ui/src/components/SettingsPanel.tsx::SettingsPanel --> <!-- @manual -->
5. Loading, empty, failure, conflict, and reconnect states follow the approved design. <!-- @impl: web-ui/src/components/admin/AdministrationLayout.tsx::AdministrationLayout --> <!-- @impl: web-ui/src/components/admin/EnvironmentIndex.tsx::EnvironmentAreaDetail --> <!-- @impl: web-ui/src/components/admin/AnalyticsPage.tsx::AnalyticsPage --> <!-- @impl: web-ui/src/components/admin/ReportsPage.tsx::ReportsPage --> <!-- @impl: web-ui/src/components/admin/ActivityPage.tsx::ActivityPage --> <!-- @manual -->
6. First-run Setup presents mode-applicable readiness, access, routing, platform, managed-environment, integration, review, apply, and result stages. <!-- @impl: web-ui/src/components/setup/SetupWizard.tsx::SetupWizard --> <!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx::ConfigureStep --> <!-- @manual -->
7. Overview includes every mode-applicable Environment summary, linked directly to its bounded editor without duplicating the sidebar's Environment navigation. <!-- @impl: web-ui/src/components/admin/AdministrationOverview.tsx::AdministrationOverview --> <!-- @test: web-ui/src/__tests__/components/AdministrationOverview.test.tsx (Administration overview Environment navigation) -->

**Constraints:** One authoritative response owns mode gating. No UI framework, chart package, icon package, or duplicate mode logic is added. The enterprise-only Operators extension is specified separately by [REQ-OPERATOR-008](operators.md#req-operator-008-enterprise-operator-administration-surface) and reuses this shell.

**Priority:** P1

**Dependencies:** [REQ-SETUP-017](#req-setup-017-mode-aware-administration-configuration-read), [REQ-AUTH-018](authentication.md#req-auth-018-admin-user-management), [REQ-SUB-009](subscription.md#req-sub-009-admin-tier-management)

**Verification:** Automated route, mode, composition, and backend mode-gate tests; user-owned manual terminology and responsive acceptance on Integration

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
6. Configured recovery displays the effective Default, Onboarding, SaaS, or Enterprise deployment mode from the setup-status response. <!-- @impl: src/routes/setup/handlers.ts::default --> <!-- @impl: web-ui/src/stores/setup.ts::loadExistingConfig --> <!-- @impl: web-ui/src/components/setup/WelcomeStep.tsx::WelcomeStep --> <!-- @test: web-ui/src/__tests__/stores/setup.test.ts (REQ-SETUP-022 AC6: hydrates onboarding deployment mode from setup status) --> <!-- @test: web-ui/src/__tests__/components/SetupWizard.test.tsx (REQ-SETUP-022 AC6: shows the hydrated Onboarding deployment mode) -->
7. Configured recovery provides a direct return to Administration. <!-- @impl: web-ui/src/components/setup/SetupWizard.tsx::SetupWizard --> <!-- @test: web-ui/src/__tests__/components/SetupWizard.test.tsx (REQ-SETUP-022 AC7: returns configured Initialization to Administration) -->

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

**Constraints:** Filtering remains client-side over the authoritative loaded response without requests, indexes, or persisted search state.

**Priority:** P1

**Dependencies:** [REQ-SETUP-017](#req-setup-017-mode-aware-administration-configuration-read), [REQ-SETUP-019](#req-setup-019-administration-and-analytics-shell)

**Verification:** Automated filtering behavior and user-owned manual empty-result acceptance on Integration

**Status:** Implemented

---

### REQ-SETUP-024: Routine OAuth identifier persistence

**Intent:** Administrators can remove saved non-secret OAuth identifiers without an internal Initialization compatibility submission erasing omitted values.

**Applies To:** Admin

**Acceptance Criteria:**

1. An explicitly blank GitHub App, GitHub OAuth, or Cloudflare OAuth client ID removes that saved identifier. <!-- @impl: src/lib/admin-configuration.ts::executeConfigurationTask --> <!-- @test: src/__tests__/routes/admin-configuration-runs.test.ts (REQ-SETUP-024: removes explicitly cleared non-secret OAuth client IDs) -->
2. A blank GitHub App, GitHub OAuth, or Cloudflare OAuth replacement secret preserves the saved secret. <!-- @impl: src/lib/admin-configuration.ts::executeConfigurationTask --> <!-- @test: src/__tests__/routes/admin-configuration-runs.test.ts (REQ-SETUP-024: preserves saved OAuth secrets when replacements are blank) -->
3. When the internal Initialization compatibility submission omits one of those client IDs, the saved identifier is preserved. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/routes/setup-enterprise-groups.test.ts (REQ-SETUP-024: omitted client IDs preserve stored values during internal initialization compatibility calls) -->

**Constraints:** Client IDs remain non-secret KV values; secret replacement remains encrypted and no-clobber on blank.

**Priority:** P0

**Dependencies:** [REQ-SETUP-018](#req-setup-018-stateless-environment-preview-and-bounded-execution), [REQ-GITHUB-008](github.md#req-github-008-enterprise-github-provider-configuration-via-setup), [REQ-AGENT-064](agents.md#req-agent-064-connect-to-cloudflare-via-oauth)

**Verification:** Automated Administration-run and Initialization compatibility tests

**Status:** Implemented

---

### REQ-SETUP-025: Responsive Administration scrolling

**Intent:** Administrators can reach routine controls at every supported viewport size.

**Applies To:** Admin

**Acceptance Criteria:**

1. Administration remains vertically scrollable at supported mobile, tablet, and desktop viewport sizes. <!-- @impl: web-ui/src/styles/administration.css::.admin-shell --> <!-- @manual -->

**Constraints:** Application-shell overflow behavior remains unchanged.

**Priority:** P1

**Dependencies:** [REQ-SETUP-019](#req-setup-019-administration-and-analytics-shell)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-SETUP-026: Workspace Administration entry

**Intent:** Administrators have one workspace route into routine administration and recovery.

**Applies To:** Admin

**Acceptance Criteria:**

1. Completed deployments expose one workspace Settings entry linking to `/admin` in every deployment mode. <!-- @impl: web-ui/src/components/SettingsPanel.tsx::SettingsPanel --> <!-- @test: web-ui/src/__tests__/components/SettingsPanel.test.tsx (REQ-SETUP-026 AC1-AC2: routes all admin access through one Administration entry) -->
2. Workspace Settings exposes no duplicate user-management or bootstrap-recovery action. <!-- @impl: web-ui/src/components/SettingsPanel.tsx::SettingsPanel --> <!-- @test: web-ui/src/__tests__/components/SettingsPanel.test.tsx (REQ-SETUP-026 AC1-AC2: routes all admin access through one Administration entry) -->

**Constraints:** Administration route contents remain mode-gated by [REQ-SETUP-019](#req-setup-019-administration-and-analytics-shell) AC2.

**Priority:** P1

**Dependencies:** [REQ-SETUP-019](#req-setup-019-administration-and-analytics-shell), [REQ-AUTH-018](authentication.md#req-auth-018-admin-user-management)

**Verification:** Automated Settings composition tests

**Status:** Implemented

---

<a id="req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var"></a>
### REQ-ENTERPRISE-006: Deploy-Time AIG Secrets and ENTERPRISE_MODE Var

**Intent:** Enterprise configuration must be supplied at deploy time through Worker bindings, kept secret where appropriate, and default to off.

**Applies To:** Admin

**Acceptance Criteria:**

1. `AIG_GATEWAY_URL` and `AIG_TOKEN` may be configured as Worker secrets so they are not stored in plaintext config or exposed to the container. <!-- @impl: .github/workflows/deploy.yml::deploy --> <!-- @manual: Inspect the deployed Worker bindings and a running container environment; confirm the values are secret bindings and absent from the container. -->
2. Enterprise mode is a non-secret deployment setting; dynamic route catalog and default remain wizard-managed KV configuration. <!-- @impl: wrangler.toml::binding --> <!-- @manual -->
3. Enterprise Mode is off by default: an absent or empty `ENTERPRISE_MODE` binding resolves to disabled. <!-- @impl: src/lib/subscription.ts::isEnterpriseMode --> <!-- @test: src/__tests__/lib/enterprise-mode.test.ts (REQ-ENTERPRISE-001 AC1 / REQ-ENTERPRISE-006 AC3: isEnterpriseMode) -->
4. When `ENTERPRISE_MODE` is enabled, sanctioned Gateway requests fail closed (503) if the resolved AI Gateway URL (wizard KV or deploy-secret fallback, [REQ-ENTERPRISE-017](#req-enterprise-017-ai-gateway-configured-in-the-setup-wizard)) is missing or unparseable (no `/v1/{account_id}/{gateway_id}` segments). <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-017: AI Gateway URL/token resolved from props (wizard) with env fallback) --> <!-- @impl: src/container/container-interception.ts::llm -->
5. When `ENTERPRISE_MODE` is configured, the CF Access application created by the setup wizard is host-scoped (bare custom domain, no path suffix) so the session cookie covers all paths uniformly; non-enterprise deployments retain the path-scoped (`/app/*`) application. <!-- @impl: src/routes/setup/access.ts::handleCreateAccessApp --> <!-- @test: src/__tests__/routes/setup/access.test.ts (enterprise mode creates a host-scoped app (bare host domain + whole-host destination)) -->
6. Enterprise setup best-effort provisions a higher-priority public service-worker bypass. It never aborts host setup, stores the app ID only after policy success, and rolls back a new app on policy failure; non-enterprise creates none. <!-- @impl: src/routes/setup/access.ts::handleCreateAccessApp --> <!-- @test: src/__tests__/routes/setup/access.test.ts (Setup Access) -->
7. The deployment workflow exposes `enterprise` and `enterprise integration` as manual-dispatch environments deployable from any branch, separate from production and integration. <!-- @impl: .github/workflows/deploy.yml::deploy --> <!-- @manual -->

**Constraints:**

- The enterprise flag is evaluated from deploy-time bindings, consistent with [REQ-SETUP-003](setup.md#req-setup-003-three-deployment-modes).
- Container env receives only the enterprise flag and non-secret route hints derived from Worker config, never session state; gateway URL, token, account ID, and resolved route remain Worker-only.
- The resolved AI Gateway URL uses wizard KV before the deploy-secret fallback and is the single source for account and gateway coordinates, so no separate account-ID binding is required.
- The Workers VPC `EGRESS` binding is enterprise-only, committed disabled, and injected at deploy only when enterprise mode is active; default, fork, and test deployments remain unaffected.
- A missing `EGRESS` binding fails strict egress closed; non-enterprise and toggle-off deployments remain inert.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-001](subscription.md#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-SETUP-003](setup.md#req-setup-003-three-deployment-modes)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ENTERPRISE-008: Enterprise Frontend Surface Suppression

**Intent:** Each deployment shows only applicable billing, quota, routing, and user-administration surfaces.

**Applies To:** User

**Acceptance Criteria:**

1. The "Manage Subscriptions" entry in Settings → Administration renders only in SaaS mode. <!-- @impl: web-ui/src/components/SettingsPanel.tsx::SettingsPanel --> <!-- @test: web-ui/src/__tests__/components/enterprise-surface-suppression.test.tsx (REQ-ENTERPRISE-008 AC1-AC2 and REQ-SETUP-026 AC1-AC2: SettingsPanel and session mode) -->
2. The Standard/Pro session-mode selector renders only in SaaS mode; in enterprise every user is implicitly Pro (advanced) per [REQ-ENTERPRISE-001](subscription.md#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode) AC2, and onboarding/default deployments have no Standard/Pro plans. <!-- @impl: web-ui/src/components/settings/SessionSection.tsx::SessionSection --> <!-- @test: web-ui/src/__tests__/components/enterprise-surface-suppression.test.tsx (REQ-ENTERPRISE-008 AC2: SessionSection mode selector) -->
3. The monthly-quota warning banners and their "Upgrade" calls-to-action render only in SaaS mode. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/enterprise-layout-suppression.test.tsx (REQ-ENTERPRISE-008 AC3: quota banners render only in SaaS mode) -->
4. In enterprise mode, a first-time auto-provisioned user is routed to the application home instead of `/app/subscribe` or the self-serve onboarding/waitlist flow. <!-- @impl: web-ui/src/App.tsx::App --> <!-- @test: web-ui/src/__tests__/components/enterprise-app-routing.test.tsx (REQ-ENTERPRISE-008 AC4: enterprise first-login routing) -->

**Constraints:**

- Billing, quota, and session-mode surfaces depend on SaaS mode.
- Administrator user-management availability depends on enterprise mode ([REQ-ENTERPRISE-015](#req-enterprise-015-enterprise-setup-user-administration-suppression)).
- Routing availability depends on enterprise mode.
- Deployment-mode gates never depend on user tier.
- Workspace Administration entry visibility is role-gated by [REQ-SETUP-026](setup.md#req-setup-026-workspace-administration-entry).
- Personal usage data and account actions are governed separately by [REQ-SUB-022](subscription.md#req-sub-022-cross-mode-personal-usage-data) and [REQ-SUB-023](subscription.md#req-sub-023-deployment-mode-account-actions).
- `GET /api/user` exposes both signals to `sessionStore`; `GET /api/auth/status` also exposes `saasMode` for `SubscribeGuard`.
- Enterprise's public `/public/auth/providers` projection is empty, so SPA root navigation cannot select the marketing login from configured Access IdPs; default, onboarding and SaaS provider projections remain unchanged. <!-- @impl: src/index.ts::app --> <!-- @test: src/__tests__/index.test.ts (REQ-ENTERPRISE-008/REQ-AUTH-022: Enterprise public providers cannot select a SaaS login on SPA root navigation) -->
- Other suppression is render-gating only: it removes no component code path for non-enterprise deployments and deletes no stored user state.
- Billing and session-mode visibility: this REQ adds the client `SubscribeGuard` saasMode redirect plus the subscription, mode-selector, quota-banner, and first-login-routing surfaces; the matching routes are made unreachable server-side in [REQ-ENTERPRISE-009](security.md#req-enterprise-009-enterprise-backend-route-hardening).

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-001](subscription.md#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-ENTERPRISE-002](subscription.md#req-enterprise-002-subscription-ui-hidden-and-subscribe-route-guarded), [REQ-ENTERPRISE-010](authentication.md#req-enterprise-010-access-gated-jit-user-provisioning), [REQ-SUB-023](subscription.md#req-sub-023-deployment-mode-account-actions)

**Verification:** Automated tests ([enterprise-surface-suppression](../../web-ui/src/__tests__/components/enterprise-surface-suppression.test.tsx), [enterprise-layout-suppression.test.tsx](../../web-ui/src/__tests__/components/enterprise-layout-suppression.test.tsx), and [enterprise-app-routing.test.tsx](../../web-ui/src/__tests__/components/enterprise-app-routing.test.tsx))

**Status:** Implemented

---

### REQ-ENTERPRISE-012: Setup-Configured Dynamic-Route Catalog and Access-Group List

**Intent:** An enterprise admin must manage an unlimited set of Cloudflare Access groups and an unlimited set of gateway dynamic routes from the setup wizard with no redeploy — the same way admin users are managed — so adding a team or a route is a wizard edit, not a code or deploy-var change.

**Applies To:** Admin

**Acceptance Criteria:**

1. Existing setup configure saves chip-list access groups and routes without a new endpoint. Names are trimmed, 1–256 characters, allow spaces, and reject commas, carriage returns, or line feeds; groups use lossless joined storage and prefill returns the trimmed values. <!-- @impl: src/routes/setup/index.ts::ConfigureBodySchema --> <!-- @impl: web-ui/src/stores/setup.ts::setupStore --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (rejects a group containing %s before setup starts) --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (round-trips trimmed access-group values through prefill) -->
2. The JSON route catalog defaults to its first entry with reasoning off; configured defaults must belong or return 400. Optional per-group route/default/reasoning maps persist separately. <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig --> <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) -->
3. `GET /api/setup/prefill` round-trips the stored groups, catalog, and default route so a setup re-run shows the current configuration; a malformed stored value degrades to empty defaults rather than failing the prefill. <!-- @impl: src/lib/kv-keys.ts::SETUP_KEYS --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (GET /prefill degrades to empty defaults when stored route JSON is malformed) -->
4. One route configuration supplies interception, container routing, JIT access, group metadata, and per-group editing ([REQ-ENTERPRISE-004](models-and-routing.md#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-005](models-and-routing.md#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls), [REQ-ENTERPRISE-007](models-and-routing.md#req-enterprise-007-gateway-route-pinning), [REQ-ENTERPRISE-010](authentication.md#req-enterprise-010-access-gated-jit-user-provisioning), [REQ-ENTERPRISE-013](models-and-routing.md#req-enterprise-013-per-group-dynamic-routing)). <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig --> <!-- @test: src/__tests__/lib/enterprise-route-config.test.ts (first matching group and optional fallback (REQ-ENTERPRISE-013/-044)) -->
5. When `ENTERPRISE_MODE` is unset, the dynamic-route catalog UI and KV reads add no behavior; the access-group field already existed and is unchanged for non-enterprise deployments. <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (GET /prefill omits the enterprise extras when ENTERPRISE_MODE is unset (regression)) -->
6. In enterprise mode, the AI-routing stage blocks "Continue" until at least one dynamic route, a Gateway URL, and a saved or newly entered Gateway token are present. <!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx::ConfigureStep --> <!-- @test: web-ui/src/__tests__/components/ConfigureStep.test.tsx (blocks AI-routing Continue when route, Gateway URL, or token is missing (REQ-ENTERPRISE-012 AC6)) --> <!-- @test: web-ui/src/__tests__/components/ConfigureStep.test.tsx (enables AI-routing Continue once route, Gateway URL, and token exist (REQ-ENTERPRISE-012 AC6)) -->
7. `POST /api/setup/configure` rejects empty or absent `dynamicRoutes` with `400` before any KV write. Runtime empty-catalog denial follows [REQ-ENTERPRISE-032](models-and-routing.md#req-enterprise-032-enterprise-pi-route-selection-and-runtime-translation) AC6. <!-- @impl: src/routes/setup/index.ts::app --> <!-- @test: src/__tests__/routes/setup.test.ts (POST /api/setup/configure) -->

**Constraints:**

- No new persistence layer or endpoint: the lists ride the existing setup wizard configure flow and KV (`SETUP_KEYS`), consistent with how `ENTERPRISE_ACCESS_GROUP` was already stored ([REQ-ENTERPRISE-010](authentication.md#req-enterprise-010-access-gated-jit-user-provisioning)).
- Access groups are stored comma/newline-joined (back-compat with the prior single-value config) and routes as a JSON array; the comma/newline ban on names keeps the joined encoding lossless.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-004](models-and-routing.md#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-005](models-and-routing.md#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls), [REQ-ENTERPRISE-007](models-and-routing.md#req-enterprise-007-gateway-route-pinning), [REQ-ENTERPRISE-010](authentication.md#req-enterprise-010-access-gated-jit-user-provisioning)

**Verification:** Automated test ([Setup configure tests](../../src/__tests__/routes/setup.test.ts), [prefill tests](../../src/__tests__/routes/setup/handlers.test.ts), [route-config resolver tests](../../src/__tests__/lib/enterprise-route-config.test.ts), [access-group parsing](../../src/__tests__/lib/access-group-resolution.test.ts), [setup store](../../web-ui/src/__tests__/stores/setup.test.ts), [ConfigureStep](../../web-ui/src/__tests__/components/ConfigureStep.test.tsx))

**Status:** Implemented

---

### REQ-ENTERPRISE-015: Enterprise Setup User-Administration Suppression

**Intent:** Enterprise setup omits the regular-user administration surface because Cloudflare Access provisions regular users on first sign-in.

**Applies To:** User

**Acceptance Criteria:**

1. In enterprise mode, the setup wizard's "Regular Users" section is not rendered. <!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx::ConfigureStep --> <!-- @test: web-ui/src/__tests__/components/ConfigureStep.test.tsx (ConfigureStep) -->
2. Outside enterprise mode, the setup wizard's "Regular Users" section renders unchanged. <!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx::ConfigureStep --> <!-- @test: web-ui/src/__tests__/components/ConfigureStep.test.tsx (ConfigureStep) -->

**Constraints:** Enterprise setup still configures Admin Users and the optional Cloudflare Access group per [REQ-ENTERPRISE-010](authentication.md#req-enterprise-010-access-gated-jit-user-provisioning). Account-menu actions are owned by [REQ-SUB-023](subscription.md#req-sub-023-deployment-mode-account-actions).

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-008](#req-enterprise-008-enterprise-frontend-surface-suppression), [REQ-ENTERPRISE-010](authentication.md#req-enterprise-010-access-gated-jit-user-provisioning)

**Verification:** Automated test ([ConfigureStep](../../web-ui/src/__tests__/components/ConfigureStep.test.tsx))

**Status:** Implemented

---

### REQ-ENTERPRISE-017: AI Gateway Configured in the Setup Wizard

**Intent:** An enterprise admin can configure the customer's AI Gateway URL + token in the Setup wizard (persisted in KV, the token encrypted) instead of supplying them as deploy-time GitHub secrets, so a fresh enterprise deployment is configurable end-to-end from the wizard with no redeploy. The deploy-time secrets ([REQ-ENTERPRISE-006](#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var)) remain an OPTIONAL fallback, so existing deployments keep working unchanged.

**Applies To:** Admin

**Acceptance Criteria:**

1. Enterprise Setup persists the gateway URL and encrypted token. <!-- @impl: src/routes/setup/index.ts::app --> <!-- @test: src/__tests__/routes/setup-enterprise-groups.test.ts (REQ-ENTERPRISE-017: persists the AI Gateway URL (plain) + token (encrypted) and emits configure_ai_gateway) -->
2. `GET /api/setup/prefill` round-trips the AI Gateway config (enterprise-only): it surfaces the non-secret `aigGatewayUrl` and optional `aigGatewayId` plus a masked `aigTokenSet` boolean (never the token itself), reports unset/empty when nothing is stored, and omits these fields entirely in a non-enterprise prefill. <!-- @impl: src/routes/setup/handlers.ts::handlers --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (Setup Handlers / REQ-SETUP-005 (admin-only auth gate on POST setup endpoints) / REQ-SETUP-006 (setup config persistence + reload) / REQ-SETUP-008 (setup wizard step state machine and validation) / REQ-SETUP-011 (allowlist persisted as KV user records via setup endpoint)) -->
3. Gateway configuration prefers saved fields and permits deployment fallback only when saved state is absent; unreadable saved credentials fail closed without throwing. <!-- @impl: src/lib/aig-config.ts::getAigConfig --> <!-- @test: src/__tests__/lib/aig-config.test.ts (env fallback: with KV unset, the deploy-secret env values are used) --> <!-- @test: src/__tests__/lib/aig-config.test.ts (fails closed without throwing when a saved credential cannot be decrypted) -->
4. Each session's LLM interceptor receives the resolved gateway URL, optional account-API gateway name, and token, with deployment fallback only for absent properties under AC3. <!-- @impl: src/container/container-interception.ts::llm --> <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-017: AI Gateway URL/token resolved from props (wizard) with env fallback) -->
5. The Setup wizard renders the enterprise-only AI Gateway URL, conditional account-API gateway name, and token fields inside an organized group; they are not rendered outside enterprise mode, and their inputs persist through setup state. <!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx::ConfigureStep --> <!-- @impl: web-ui/src/components/setup/SetupSection.tsx::SetupSection --> <!-- @impl: web-ui/src/stores/setup.ts::setupStore --> <!-- @test: web-ui/src/__tests__/components/ConfigureStep.test.tsx (ConfigureStep) -->
6. The "Configuring Codeflare" progress screen reflects the steps it runs: the configure endpoint emits named `configure_*` steps (`configure_access_groups`, `configure_model_routing`, `configure_ai_gateway`, `configure_browser_rendering`, `configure_strict_egress`), and the progress UI maps each to a friendly label. <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) --> <!-- @manual -->
7. Enterprise AI Gateway guidance names the Workers AI, AI Gateway Run, and AI Gateway Read permissions required for inference and route discovery. <!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx::ConfigureStep --> <!-- @test: web-ui/src/__tests__/components/ConfigureStep.test.tsx (shows the required gateway token permissions (REQ-ENTERPRISE-017 AC7)) -->

**Constraints:**

- The token is a secret: stored encrypted (kv-crypto, same shape as the Browser Rendering token, [REQ-BROWSER-007](browser-run.md#req-browser-007-enterprise-admin-configured-browser-rendering-token)), masked on prefill, no-clobber on blank, and never returned to the client; The URL is non-secret and stored plain.
- URL and token resolve independently with wizard KV before deploy secrets, allowing mixed sources only when the corresponding saved value is absent ([REQ-ENTERPRISE-006](#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var) AC1).
- Unreadable saved credentials deny inference under AC3.
- The token never enters the container, as required by [REQ-ENTERPRISE-005](models-and-routing.md#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls) AC4.
- Grouping fields into `SetupSection`s preserves every field, store binding, and conditional gate; only visual grouping changes.
- `SetupSection` is a reusable structure-only component with no copy.
- Routine Administration reads and validates the same effective URL and token through [REQ-SETUP-017](setup.md#req-setup-017-mode-aware-administration-configuration-read); no Worker-binding or unauthenticated transport is added.
- The effective token carries Workers AI, AI Gateway Run, and AI Gateway Read so authenticated Administration can discover the gateway-owned Dynamic Route catalog without exposing the credential or duplicating route handles.

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-004](models-and-routing.md#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-006](#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var), [REQ-BROWSER-007](browser-run.md#req-browser-007-enterprise-admin-configured-browser-rendering-token)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ENTERPRISE-025: Active Coding Agents Configured in the Setup Wizard

**Intent:** An enterprise admin selects in the Setup wizard which build-installed, gateway-capable coding agents users may pick at session creation (minimum one when that universe is non-empty), persisted in KV with no redeploy; an absent configuration keeps every installed capable agent active.

**Applies To:** Admin

**Acceptance Criteria:**

1. The wizard's Coding Agents offering and pre-checked selection derive from the setup prefill: installed stored selections when present, every installed capable agent otherwise. <!-- @impl: src/routes/setup/handlers.ts::handlers --> <!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx::ConfigureStep --> <!-- @test: web-ui/src/__tests__/stores/setup.test.ts (hydrates the selection and the governable universe from the enterprise prefill) --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (GET /prefill defaults to every governable agent when nothing is stored) --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (REQ-ENTERPRISE-025 AC1: GET /prefill hides capable agents omitted from the image) -->
2. The admin's selection persists through its own `configure_active_agents` setup step to KV `setup:active_agents` and round-trips on the wizard prefill together with the governable universe. <!-- @impl: src/lib/kv-keys.ts::SETUP_KEYS --> <!-- @test: src/__tests__/routes/setup-enterprise-groups.test.ts (REQ-ENTERPRISE-025: persists the active-agent selection as JSON with its own step) --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (GET /prefill surfaces the stored selection plus the governable universe) -->
3. The configure endpoint rejects an empty, non-capable, or build-omitted agent selection. <!-- @impl: src/routes/setup/index.ts::ConfigureBodySchema --> <!-- @impl: src/routes/setup/index.ts::app --> <!-- @test: src/__tests__/routes/setup-enterprise-groups.test.ts (REQ-ENTERPRISE-025: rejects an empty active-agent selection with 400) --> <!-- @test: src/__tests__/routes/setup-enterprise-groups.test.ts (REQ-ENTERPRISE-025 AC3: rejects a capable agent whose CLI is omitted from the image) -->
4. The wizard blocks unchecking the last active agent (minimum one). <!-- @impl: web-ui/src/stores/setup.ts::toggleActiveAgent --> <!-- @test: web-ui/src/__tests__/stores/setup.test.ts (toggling removes an active agent but never the last one) -->
5. A reconfigure that omits the field leaves the stored selection untouched, and non-enterprise setups never write it. <!-- @impl: src/routes/setup/index.ts::ConfigureBodySchema --> <!-- @test: src/__tests__/routes/setup-enterprise-groups.test.ts (REQ-ENTERPRISE-025: never writes the selection when the field is absent) -->

**Constraints:**

- The selectable universe is capped by gateway routability and the build-installed set ([REQ-ENTERPRISE-004](models-and-routing.md#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-OPS-040](operations.md#req-ops-040-selected-coding-agent-packaging)); the wizard can never add an agent beyond either boundary.
- `bash` is not wizard-governable — tabs 2-6 are plain bash in every session, so deactivating it would remove nothing.
- The selection is KV-backed like every sibling wizard toggle; a change propagates within KV's eventual-consistency window, not as a per-session strong-consistency guarantee.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-001](subscription.md#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-AGENT-001](agents.md#req-agent-001-support-multiple-ai-coding-agents), [REQ-OPS-040](operations.md#req-ops-040-selected-coding-agent-packaging)

**Verification:** Automated test ([Setup persistence + validation](../../src/__tests__/routes/setup-enterprise-groups.test.ts), [prefill](../../src/__tests__/routes/setup/handlers.test.ts), [wizard store](../../web-ui/src/__tests__/stores/setup.test.ts))

**Status:** Implemented

---

### REQ-ENTERPRISE-034: Enterprise Pi Route Administration

**Intent:** Administrators can configure gateway-owned route reasoning without duplicating routes or authoring low-level mappings.

**Applies To:** Admin

**Acceptance Criteria:**

1. Administration lists live gateway routes. Explicit saved-connection reconciliation permanently removes authoritatively absent Dynamic settings and owned Native policy references without widening access. <!-- @impl: src/routes/admin/reasoning.ts::reasoningRoutes --> <!-- @test: src/__tests__/routes/admin-reasoning.test.ts (accepts documented data.routes and returns the exact sanitized catalog schema) --> <!-- @test: src/__tests__/routes/admin-reasoning.test.ts (reuses the saved gateway credential and accepts the compatible result.routes envelope) --> <!-- @test: src/__tests__/routes/admin-reasoning.test.ts (returns exact active-version leg/path summaries and only administrator-owned custom-provider identity) --> <!-- @test: src/__tests__/routes/live-routing-reconciliation.test.ts (REQ-ENTERPRISE-034: permanently prunes absent Dynamic settings and owned Native policy references without widening access) -->
2. Normal Discover automatically adopts a qualified shared contract and server receipt, without a profile chooser, naming step or separate Verify. Manual controls remain under Advanced. <!-- @impl: web-ui/src/components/admin/TargetCapabilityDiscovery.tsx::TargetCapabilityDiscovery --> <!-- @test: web-ui/src/__tests__/components/TargetCapabilityDiscovery.test.tsx -->
3. Detected models load automatically through read-only inventory and appear inside the selected route, outside advanced technical details. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingWorkspace.test.tsx (REQ-ENTERPRISE-041: starts with a compact route overview and expands only the selected route) -->
4. Group, default, preview, and Apply controls require neither editable JSON nor manual route duplication. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-034: adds a discovered route only after verification and policy assignment and preserves apply-to-all) -->
5. In the retained Advanced matcher, explicit administrator selection places the exact revision in the draft; normal Discover performs that selection automatically after qualification. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (uses the exact matched $name catalog revision only in the route draft) -->
6. Historical Advanced mapping and selected-profile checks retain their fixed 4,096-token budget. Normal capability discovery and generated-Native verification use the bounded campaign in REQ-ENTERPRISE-035/075. <!-- @impl: web-ui/src/components/admin/ReasoningProfileEditor.tsx::ReasoningProfileEditor --> <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/ReasoningProfileEditor.test.tsx (starts on mount with fixed 4096 and offers no second start or token input, including after incomplete results) --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-038: Verify Profile uses fixed 4096 and attaches the server receipt only to the exact route draft) -->
7. A verified existing-profile assignment can be saved independently of unfinished gateway routes. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingWorkspace.test.tsx (REQ-ENTERPRISE-044: one working group route permits Save despite incomplete inactive routes) -->

**Constraints:**

- Prune absent Dynamic assignments, contexts, defaults and policies; retain shared revisions/receipts. Native-looking names remain Dynamic without a saved Native owner. <!-- @impl: src/routes/admin/reasoning.ts::reasoningRoutes --> <!-- @test: src/__tests__/routes/live-routing-reconciliation.test.ts (REQ-ENTERPRISE-034: permanently prunes absent Dynamic settings and owned Native policy references without widening access) -->

- Use existing admission/revision ownership. Revision, connection, Setup or ownership drift aborts writes; applied cleanup advances revision and invalidates previews. <!-- @impl: src/routes/admin/configuration-runs.ts::reconcileSavedAiRoutingConfiguration --> <!-- @test: src/__tests__/routes/live-routing-reconciliation.test.ts (REQ-SETUP-018: reconciliation shares admission and invalidates a previously reviewed configuration revision) --> <!-- @test: src/__tests__/routes/live-routing-reconciliation.test.ts (REQ-SETUP-018: revision, connection, setup and run-ownership drift during management I/O abort before routing writes) -->

- Accept `data.page`/`data.per_page` without mandatory totals; collect complete inventories within ten pages/1,000 routes. <!-- @impl: src/lib/ai-gateway-management.ts::listDynamicRoutes --> <!-- @test: src/__tests__/routes/live-routing-reconciliation.test.ts (REQ-ENTERPRISE-034: Cloudflare page/per_page inventory remains connected and prunes only after completion ($label)) -->
- Failed pages, pagination drift, duplicates or exhausted bounds never authorize deletion. <!-- @test: src/__tests__/routes/live-routing-reconciliation.test.ts (REQ-ENTERPRISE-047: an incomplete Cloudflare paged inventory preserves all saved settings (%s)) -->
- Only `POST /catalog {reconcileSaved:true,baseRevision}` reconciles complete saved-Gateway inventories. GET, ordinary POST and overlays are read-only; reject reconciliation overlays and deletion lists. <!-- @impl: src/routes/admin/reasoning.ts::reasoningRoutes --> <!-- @test: src/__tests__/routes/live-routing-reconciliation.test.ts (REQ-ENTERPRISE-042: GET and draft catalog checks remain read-only and cannot smuggle edits into reconciliation) -->

- Gateway-owned routes/backends cannot be forced or inferred.
- Manual assignment needs no discovery.
- UI checks never retry or escalate automatically.
- Advanced discovery retains 32–16,384 tokens (default 4,096), independently of target discovery.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-012](#req-enterprise-012-setup-configured-dynamic-route-catalog-and-access-group-list), [REQ-ENTERPRISE-013](models-and-routing.md#req-enterprise-013-per-group-dynamic-routing), [REQ-ENTERPRISE-031](models-and-routing.md#req-enterprise-031-enterprise-pi-capability-profile-administration), [REQ-ENTERPRISE-033](models-and-routing.md#req-enterprise-033-enterprise-pi-discovery-and-multi-model-evidence)

**Verification:** Regression checkpoint `bef54164` failed in CI `34770156766`. Updated implementation and behavioral fixtures await exact-head CI; no deployed acceptance is claimed.

**Status:** Planned

---

### REQ-ENTERPRISE-036: Enterprise Pi Custom Profile Draft Lifecycle

**Intent:** Administrators can name and assign discovered custom profiles in a route draft, then save them together.

**Applies To:** Admin

**Acceptance Criteria:**

1. Create & Assign adds a named immutable custom revision to the configuration draft. <!-- @impl: web-ui/src/components/admin/ReasoningProfileEditor.tsx::ReasoningProfileEditor --> <!-- @test: web-ui/src/__tests__/components/ReasoningProfileEditor.test.tsx (Discover Profile starts exactly once and creates a canonical route draft without submitting Save) -->
2. Create & Assign selects that exact revision only for the mapped route's draft assignment. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/EnvironmentIndex.test.tsx (saves a mapped custom revision while preserving another configured route and its saved custom profile) -->
3. Returning from Save confirmation to edit retains the revision and assignment draft. <!-- @impl: web-ui/src/components/admin/EnvironmentIndex.tsx::EnvironmentAreaDetail --> <!-- @test: web-ui/src/__tests__/components/EnvironmentIndex.test.tsx (creates and assigns to the mapped route only, retaining the canonical draft until explicit Save) -->
4. Save confirmation persists the named revision and route assignment atomically. <!-- @impl: web-ui/src/components/admin/EnvironmentIndex.tsx::EnvironmentAreaDetail --> <!-- @impl: src/lib/admin-configuration.ts::executeConfigurationTask --> <!-- @test: src/__tests__/routes/admin-configuration-runs.test.ts (REQ-ENTERPRISE-031: persists named custom revisions and exact assignments through Save→GET and preserves the catalog when legacy saves omit it) -->
5. Reloading saved configuration restores the custom profile and exact route assignment. <!-- @impl: src/routes/admin/configuration.ts::app --> <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: src/__tests__/routes/admin-configuration-runs.test.ts (REQ-ENTERPRISE-031: persists named custom revisions and exact assignments through Save→GET and preserves the catalog when legacy saves omit it) --> <!-- @test: web-ui/src/__tests__/components/EnvironmentIndex.test.tsx (creates and assigns to the mapped route only, retaining the canonical draft until explicit Save) -->

**Constraints:**

- Custom profile drafts retain sanitized advisory evidence, remain unverified, and require warning confirmation before activation.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-031](models-and-routing.md#req-enterprise-031-enterprise-pi-capability-profile-administration), [REQ-ENTERPRISE-034](#req-enterprise-034-enterprise-pi-route-administration), [REQ-ENTERPRISE-035](models-and-routing.md#req-enterprise-035-enterprise-pi-protocol-match-selection), [REQ-ENTERPRISE-037](models-and-routing.md#req-enterprise-037-enterprise-pi-custom-profile-generation)

**Verification:** Automated tests in the anchored Administration web-ui and configuration-run suites above.

**Status:** Implemented

---

### REQ-ENTERPRISE-041: Enterprise Pi Administrator Workspace

**Intent:** Administrators can find a route, understand its state, without scanning implementation details.

**Applies To:** Admin

**Acceptance Criteria:**

1. The initial route overview presents route names and status without expanding every route's controls. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingWorkspace.test.tsx (REQ-ENTERPRISE-041: starts with a compact route overview and expands only the selected route) -->
2. Opening another route preserves unsaved edits in the previous route. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingWorkspace.test.tsx (REQ-ENTERPRISE-041: switching route details preserves unsaved values) -->
3. Connection, Dynamic routes, Native routes, and access policies have distinct, keyboard-operable section navigation. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingWorkspace.test.tsx (REQ-ENTERPRISE-041: section navigation retains configuration state) --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-041: navigates Dynamic routes and Native routes and adds a Native Route) -->
4. Add Native Route adds a native draft. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-041: navigates Dynamic routes and Native routes and adds a Native Route) -->

**Constraints:**

- The incumbent Administration tokens, responsive layout and accessible controls remain authoritative.
- Discover and Advanced verification share one visible Check result above a single Advanced: choose a profile disclosure. <!-- @impl: web-ui/src/components/admin/TargetCapabilityDiscovery.tsx::TargetCheckResult --> <!-- @test: web-ui/src/__tests__/components/TargetCapabilityDiscovery.test.tsx (REQ-ENTERPRISE-038: Advanced verification updates the same visible result without requiring the disclosure to stay open) -->
- Tool calling, Reasoning, Streaming and Input caching remain visible as four independently labelled outcomes, including partial results and per-level Native differences; no current grade is shown. Technical attempts/diagnostics start collapsed while Review changes → Confirm Save → next normal session guidance remains visible. <!-- @impl: web-ui/src/components/admin/TargetCapabilityDiscovery.tsx::TargetCheckResult --> <!-- @test: web-ui/src/__tests__/components/TargetCapabilityDiscovery.test.tsx (REQ-ENTERPRISE-041: Discover leaves one visible result and the review/save next step outside optional profile controls) --> <!-- @test: web-ui/src/__tests__/components/TargetCapabilityDiscovery.test.tsx (REQ-ENTERPRISE-041: %s mixed evidence keeps four independent capability outcomes visible with details collapsed) --> <!-- @test: web-ui/src/__tests__/components/TargetCapabilityDiscovery.test.tsx (REQ-ENTERPRISE-041: legacy grades never appear in the result or expanded attempt history) -->
- Non-Bedrock Native profile controls start expanded. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/TargetCapabilityDiscovery.test.tsx (REQ-ENTERPRISE-041: non-Bedrock Native keeps its consolidated Advanced controls open and publishes verification outside them) -->
- Mobile layout keeps fields, identifiers, results and 44px actions within the viewport. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @manual: Check single-column mobile fields, wrapped model identifiers, visible result/next step, and 44px action targets without horizontal overflow. -->
- Section and route navigation must not discard drafts or start paid checks.
- Mapping and verification use one compact indeterminate progress indicator at the active route, without repeated headings, explanatory paragraphs, or duplicate bottom-of-form status. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingWorkspace.test.tsx (REQ-ENTERPRISE-041: verification progress is visible beside the route without a bottom duplicate) -->
- A finished mapping error does not lock profile selection; choosing another profile dismisses the old result. <!-- @test: web-ui/src/__tests__/components/AiRoutingWorkspace.test.tsx (REQ-ENTERPRISE-041: mapping failure unlocks profile selection and keeps progress local) -->

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-034](#req-enterprise-034-enterprise-pi-route-administration), [REQ-ENTERPRISE-040](models-and-routing.md#req-enterprise-040-enterprise-pi-check-lifecycle)

**Verification:** Anchored behavioral fixtures; execution is CI-only.

**Status:** Implemented

---

### REQ-ENTERPRISE-042: Enterprise Pi Draft Connection and Verification

**Intent:** Check the actual gateway and draft translation without a Save-before-Verify deadlock.

**Applies To:** Admin

**Acceptance Criteria:**

1. Connection status reports route-management readiness rather than merely the presence of a token. <!-- @impl: src/lib/ai-gateway-management.ts::connectionStatus --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (reports sanitized permission-denied for management %s without asserting the exact missing scope) -->
2. Invalid draft gateway credentials or provenance are rejected before external I/O. <!-- @impl: src/routes/admin/reasoning.ts::reasoningRoutes --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (rejects invalid draft gateway coordinates, credentials and provenance before external I/O) -->
3. Transient connection overlays reuse saved encrypted credentials without persisting replacements or reconciling saved routing during checks. <!-- @impl: src/lib/ai-gateway-management.ts::resolveGatewayConnection --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (reuses the saved encrypted token for draft inspection without changing storage) --> <!-- @test: web-ui/src/__tests__/components/AiRoutingWorkspace.test.tsx (REQ-ENTERPRISE-042: checking changed credentials does not save or run model probes) --> <!-- @test: src/__tests__/routes/live-routing-reconciliation.test.ts (REQ-ENTERPRISE-042: GET and draft catalog checks remain read-only and cannot smuggle edits into reconciliation) -->
4. Selected verification accepts one bounded canonical unsaved custom revision with its exact reference. <!-- @impl: src/routes/admin/reasoning.ts::reasoningRoutes --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (verifies an unsaved canonical custom profile and draft gateway without activation) --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (rejects invalid, mismatched and mutated or disabled existing custom drafts before provider I/O) -->
5. Verification accepts custom-provider and multi-model routes without a backend description. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingWorkspace.test.tsx (REQ-ENTERPRISE-042: verifies a three-model route without requiring a custom backend description) -->
6. Absent custom provenance limits live evidence to the observed path. <!-- @impl: src/lib/reasoning-verification.ts::checkedRouteInventory --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (verifies an undescribed custom backend without inventing inherited provenance) -->

**Constraints:** Checks preserve admin authorization, invoke no model probes, and return no saved credential.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-017](#req-enterprise-017-ai-gateway-configured-in-the-setup-wizard), [REQ-ENTERPRISE-038](models-and-routing.md#req-enterprise-038-enterprise-pi-selected-profile-verification)

**Verification:** Regression checkpoint `bef54164` failed in CI `34770156766`. Updated implementation and behavioral fixtures await exact-head CI; no deployed acceptance is claimed.

**Status:** Planned

---

### REQ-ENTERPRISE-044: Enterprise Pi Minimum Save and Access Policies

**Intent:** Save gateway and provider configuration independently while activating only complete access policies.

**Applies To:** Admin

**Acceptance Criteria:**

1. A checked gateway connection can be saved without any Dynamic Route, group assignment, or fallback route. <!-- @impl: src/lib/admin-configuration.ts::validateConfigurationValues --> <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: src/__tests__/routes/admin-configuration-preview.test.ts (accepts an AI Gateway connection before routes or access policies exist) --> <!-- @test: web-ui/src/__tests__/components/EnvironmentIndex.test.tsx (REQ-ENTERPRISE-044: reviews a checked connection change before routes or access policies exist) -->
2. Invalid inactive context inputs do not block Save or discard valid retained draft windows. <!-- @impl: src/lib/admin-configuration.ts::validateConfigurationValues --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (preserves valid inactive draft context windows and ignores invalid replacements without exposing inactive routes) -->
3. Adding a group with exactly one eligible route preselects that route. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingWorkspace.test.tsx (REQ-ENTERPRISE-044: a single eligible route defaults to a supported preference %s) -->
4. New default reasoning prefers Medium, then Off, then the first supported level. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingWorkspace.test.tsx (REQ-ENTERPRISE-044: a single eligible route defaults to a supported preference %s) -->
5. Unmatched users receive only the enabled fallback subset, or no routes when fallback is disabled. <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (disabled fallback denies unmatched users and enabled fallback exposes only its allowed verified subset) -->
6. The first matching configured group remains authoritative even when reconciliation removes every route. Empty deny-only groups survive; exhausted fallback is disabled rather than widened. <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (does not fall through from the first matching policy when its routes become ineligible) --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (saves and retains an explicit empty deny-only first group alongside a working group) --> <!-- @test: src/__tests__/routes/live-routing-reconciliation.test.ts (REQ-ENTERPRISE-044: complete empty inventories persist deny-only groups and disabled fallback, then reconcile idempotently) -->
7. Any editable draft that differs semantically from saved state can reach authoritative Review validation without a client-side readiness gate. <!-- @impl: web-ui/src/components/admin/EnvironmentIndex.tsx::EnvironmentAreaDetail --> <!-- @test: web-ui/src/__tests__/components/EnvironmentIndex.test.tsx (REQ-ENTERPRISE-044/057: replacement credentials preserve saved policies regardless of connection edit order (%s)) -->

**Constraints:**

- Cleanup preserves surviving policy order and supported defaults. If a default disappears, choose only a surviving allowed route and supported reasoning; an empty global default uses Off. Repeated unchanged reconciliation does not advance the revision. <!-- @impl: src/routes/admin/reasoning.ts::reasoningRoutes --> <!-- @test: src/__tests__/routes/live-routing-reconciliation.test.ts (REQ-ENTERPRISE-034: permanently prunes absent Dynamic settings and owned Native policy references without widening access) --> <!-- @test: src/__tests__/routes/live-routing-reconciliation.test.ts (REQ-ENTERPRISE-044: complete empty inventories persist deny-only groups and disabled fallback, then reconcile idempotently) -->

- Active dynamic routes are the union of eligible group and enabled fallback routes.
- Inactive profile assignments remain editable drafts.
- Only explicit policy removal deletes an empty configured group.
- Fallback uses the same available-route and supported-default controls as groups.
- The primary action is labeled Review changes, matching other Environment areas; Confirm Save retains warning acknowledgements and baseRevision protection.
- Connection/inventory loading and policy normalization alone are not edits; reverting edits disables review again.
- Back to edit preserves the editor draft and verification receipts without treating that draft as a new clean baseline.
- Actionable validation, loading, and error help remains visible; no redundant ready-to-save success message is shown.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-043](models-and-routing.md#req-enterprise-043-enterprise-pi-verified-route-activation)

**Verification:** Regression checkpoint `bef54164` failed in CI `34770156766`. Updated implementation and behavioral fixtures await exact-head CI; no deployed acceptance is claimed.

**Status:** Planned

---

### REQ-ENTERPRISE-045: Pi Compatibility Profile Communication

**Intent:** Administrators understand profiles as Pi-to-AI-Gateway translation for tool calling and reasoning, including their tested provider basis.

**Applies To:** Admin

**Acceptance Criteria:**

1. Profile selection and mapping identify the profile as a Pi compatibility profile rather than a reasoning-only setting. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @impl: web-ui/src/components/admin/ReasoningProfileEditor.tsx::ReasoningProfileEditor --> <!-- @test: web-ui/src/__tests__/components/AiRoutingWorkspace.test.tsx (REQ-ENTERPRISE-045: explains the tested provider basis without changing the active profile) -->
2. Built-in profile presentation identifies the tested provider and model family without changing the active profile reference. <!-- @impl: web-ui/src/components/admin/pi-profile-presentation.ts::profileDisplayName --> <!-- @impl: web-ui/src/components/admin/pi-profile-presentation.ts::profileValidationBasis --> <!-- @test: web-ui/src/__tests__/components/AiRoutingWorkspace.test.tsx (REQ-ENTERPRISE-045: explains the tested provider basis without changing the active profile) -->
3. Custom profile names remain user-owned and do not acquire an invented tested provider. <!-- @impl: web-ui/src/components/admin/pi-profile-presentation.ts::profileDisplayName --> <!-- @test: web-ui/src/__tests__/components/pi-profile-presentation.test.ts (preserves a custom name without inventing a tested provider) -->
4. The Advanced matcher retains named Create & Assign for an unmatched compatible draft. Normal Discover automatically creates/reuses a shared contract without requiring a name. <!-- @impl: web-ui/src/components/admin/ReasoningProfileEditor.tsx::ReasoningProfileEditor --> <!-- @test: web-ui/src/__tests__/components/ReasoningProfileEditor.test.tsx (Discover Profile starts exactly once and creates a canonical route draft without submitting Save) -->
5. A provider-controlled profile permits an Off default preference with visible Provider-default/no-override help, never a verified-disabled claim. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::PolicyFields --> <!-- @test: web-ui/src/__tests__/components/TargetCapabilityDiscovery.test.tsx (REQ-ENTERPRISE-045: %s receipt permits an Off default preference and access without inventing cache or saving) -->
6. A provider-controlled route summary shows Provider default rather than unsupported Off or missing levels. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-045/070: presents Dynamic Bedrock reasoning as provider-controlled instead of unsupported Off) -->
7. A matched provider-controlled profile shows Provider default rather than missing levels. <!-- @impl: web-ui/src/components/admin/ReasoningProfileEditor.tsx::ReasoningProfileEditor --> <!-- @test: web-ui/src/__tests__/components/ReasoningProfileEditor.test.tsx (REQ-ENTERPRISE-045: shows a matched empty level set as Provider default and preserves its assignment) -->

**Constraints:**

- Tested-provider metadata never identifies the backend of another compatible route.
- Profile IDs, canonical names, revisions, hashes and request mappings remain immutable.
- No Bedrock integration or new model protocol is introduced.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-035](models-and-routing.md#req-enterprise-035-enterprise-pi-protocol-match-selection), [REQ-ENTERPRISE-036](#req-enterprise-036-enterprise-pi-custom-profile-draft-lifecycle)

**Verification:** Anchored behavioral fixtures; execution is CI-only.

**Status:** Implemented

---

### REQ-ENTERPRISE-046: Enterprise Pi Configuration Confirmation

**Intent:** Administrators understand and explicitly confirm routing changes before persistence.

**Applies To:** Admin

**Acceptance Criteria:**

1. Save confirmation presents connection, Dynamic routes, Native routes and access changes as readable summaries; Native group/fallback handles resolve to `Native Route - <label>` from authoritative after-state or unchanged current-state. <!-- @impl: web-ui/src/components/admin/EnvironmentIndex.tsx::EnvironmentAreaDetail --> <!-- @test: web-ui/src/__tests__/components/AiRoutingReview.test.tsx (REQ-ENTERPRISE-041: summarizes routing changes in human-readable sections) -->
2. Save warnings remain visible and require their existing explicit acknowledgements before confirmation. <!-- @impl: web-ui/src/components/admin/EnvironmentIndex.tsx::EnvironmentAreaDetail --> <!-- @test: web-ui/src/__tests__/components/AiRoutingReview.test.tsx (REQ-ENTERPRISE-041: warnings require individual acknowledgement and an explicit Confirm Save action) -->

**Constraints:**

- Secret values never appear in summaries; technical identifiers remain in a disclosure. Existing redaction applies to Native labels; missing/deleted names remain honestly unavailable, never fabricated or sourced from browser-only values. Opaque policy payload IDs are unchanged. <!-- @impl: web-ui/src/components/admin/AiRoutingReview.tsx::AiRoutingSummary --> <!-- @test: web-ui/src/__tests__/components/AiRoutingReview.test.tsx (REQ-ENTERPRISE-046: resolves $section allowed and default native routes from authoritative $source labels, not submitted values (saved: $saved)) --> <!-- @test: web-ui/src/__tests__/components/AiRoutingReview.test.tsx (REQ-ENTERPRISE-046: labels changed route sections Dynamic routes and Native routes (saved: %s)) -->
- Confirmation preserves the reviewed values, warning codes, and baseRevision.
- Reviewed Environment execution keeps per-task running and succeeded statuses visible outside Technical details, using the existing configuration-run stream and status styling. <!-- @impl: web-ui/src/components/admin/EnvironmentIndex.tsx::EnvironmentAreaDetail --> <!-- @test: web-ui/src/__tests__/components/EnvironmentIndex.test.tsx (REQ-ENTERPRISE-041: streams visible task progress outside technical details) -->

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-031](models-and-routing.md#req-enterprise-031-enterprise-pi-capability-profile-administration)

**Verification:** Anchored behavioral fixtures; execution is CI-only.

**Status:** Implemented

---

<a id="req-enterprise-051-native-ai-gateway-target-administration-workspace"></a>
### REQ-ENTERPRISE-051: Native AI Gateway Provider and Model Workspace

**Intent:** Administrators edit exact native and custom AI Gateway provider/model drafts without treating route-derived suggestions as authority.

**Applies To:** Admin

**Acceptance Criteria:**

1. Administrators can select any uniquely selectable provider, and the selection updates the target draft. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-051/056/064: renders named native target rows with expanded-only controls) -->
2. Administrators can edit a target label, and the edited label remains in the target draft. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-051: edits the target label and context window in the native draft) -->
3. Administrators can enter an exact model identifier that is absent from the suggestions, and that exact value remains in the target draft. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-051: accepts an exact model independently of provider-scoped optional suggestions) -->
4. Administrators can edit a target context window, and the numeric value remains in the target draft. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-051: edits the target label and context window in the native draft) -->
5. Route-derived model suggestions contain only models for the selected provider and do not constrain the exact-model input. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-051: accepts an exact model independently of provider-scoped optional suggestions) -->

**Constraints:** Administration remains retryable while profile lifecycle, identity, and Save authority stay with [REQ-ENTERPRISE-054](#req-enterprise-054-native-target-profile-and-lifecycle-administration), [REQ-ENTERPRISE-053](models-and-routing.md#req-enterprise-053-native-target-identity-and-document), and [REQ-ENTERPRISE-055](models-and-routing.md#req-enterprise-055-native-target-authority-and-save).

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-047](models-and-routing.md#req-enterprise-047-native-ai-gateway-provider-discovery-and-selection), [REQ-ENTERPRISE-048](models-and-routing.md#req-enterprise-048-native-provider-capability-catalog), [REQ-ENTERPRISE-053](models-and-routing.md#req-enterprise-053-native-target-identity-and-document)

**Verification:** Anchored behavioral fixtures and CI.

**Status:** Implemented

---

### REQ-ENTERPRISE-054: Native Target Profile and Lifecycle Administration

**Intent:** Administrators can select an exact immutable profile revision, establish its authority, and add or remove the target without a separate activation control.

**Applies To:** Admin

**Acceptance Criteria:**

1. Selecting a built-in profile stores that exact immutable revision reference in the target draft. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-054: selects the exact %s profile revision in the target draft) -->
2. Selecting a saved custom profile stores that exact immutable revision reference in the target draft. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-054: selects the exact %s profile revision in the target draft) -->
3. Advanced Discover Profile retains compatibility matching without automatic draft adoption. Normal Bedrock Discover instead verifies/adopts the exact target under REQ-ENTERPRISE-075. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @impl: web-ui/src/components/admin/ReasoningProfileEditor.tsx::ReasoningProfileEditor --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-054: invokes native compatibility discovery for the current target draft) -->
4. Verify Profile verifies the exact selected profile and records only the returned server-issued check and target identity in the draft. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-054: verifies the exact selected profile and records its server-issued draft state) -->
5. Eligible selected profiles, including generated contracts, may be explicitly administrator-confirmed through an exact server-issued receipt without inventing automated evidence or generated-profile cache permission. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @impl: src/routes/admin/reasoning.ts::reasoningRoutes --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-054: verification automatically enables the native target draft) --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (REQ-ENTERPRISE-054: administrator confirmation issues server identity, persists authority, and leaves it unchanged on route-only Save) --> <!-- @test: src/__tests__/routes/target-capability-discovery.test.ts (REQ-ENTERPRISE-075: confirms selected Native $profile.id through endpoint, Save and runtime without borrowing tools or cache evidence) -->
6. Successful verification or administrator confirmation makes the target Ready automatically. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-054: verification automatically enables the native target draft) -->
7. Remove target deletes that target from the editable draft. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-054: removes a native target from the editable draft) -->

**Constraints:** Administrator confirmation remains an Admin action and never claims automated evidence.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-048](models-and-routing.md#req-enterprise-048-native-provider-capability-catalog), [REQ-ENTERPRISE-051](#req-enterprise-051-native-ai-gateway-provider-and-model-workspace), [REQ-ENTERPRISE-052](models-and-routing.md#req-enterprise-052-native-provider-verification-and-runtime-enforcement), [REQ-ENTERPRISE-053](models-and-routing.md#req-enterprise-053-native-target-identity-and-document), [REQ-ENTERPRISE-055](models-and-routing.md#req-enterprise-055-native-target-authority-and-save)

**Verification:** Regression checkpoint `bef54164` failed in CI `34770156766`. Updated implementation and behavioral fixtures await exact-head CI; no deployed acceptance is claimed.

**Status:** Planned

---

<a id="req-enterprise-056-native-target-disclosure-and-readiness"></a>
### REQ-ENTERPRISE-056: Native Target Disclosure and Readiness

**Intent:** Administration presents added native targets compactly and communicates their proof-derived policy availability.

**Applies To:** Admin

**Acceptance Criteria:**

1. Administration lists each added target as one collapsed provider-model row. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-051/056/064: renders named native target rows with expanded-only controls) -->
2. Opening a target row exposes its fields and current Check result, retaining saved independent capability detail after reload; profile actions are grouped in one Advanced disclosure. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-051/056/064: renders named native target rows with expanded-only controls) -->
3. Targets without current proof show orange Not ready status; ready targets distinguish green Verified from Administrator-confirmed without a fresh check. <!-- @test: web-ui/src/__tests__/components/TargetCapabilityDiscovery.test.tsx (REQ-ENTERPRISE-043: saved Native %s authority has a distinct visible basis without a fresh check) --> <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-056: derives orange and green native readiness without an enable control) -->
4. Only targets with current proof and valid context are ready for access policies. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-056: derives orange and green native readiness without an enable control) -->
5. Access-policy checkboxes and default-route choices show each native target's provider and trimmed user label, falling back to its exact model when the label is absent or blank. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::PolicyFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-064: #110 uses the native label or model fallback in group and fallback policies (%s)) -->

**Constraints:** Readiness has no separate toggle while editing and lifecycle remain with [REQ-ENTERPRISE-051](#req-enterprise-051-native-ai-gateway-provider-and-model-workspace) and [REQ-ENTERPRISE-054](#req-enterprise-054-native-target-profile-and-lifecycle-administration).

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-051](#req-enterprise-051-native-ai-gateway-provider-and-model-workspace), [REQ-ENTERPRISE-054](#req-enterprise-054-native-target-profile-and-lifecycle-administration)

**Verification:** Regression checkpoint `bef54164` failed in CI `34770156766`. Updated implementation and behavioral fixtures await exact-head CI; no deployed acceptance is claimed.

**Status:** Planned

---

### REQ-ENTERPRISE-057: AI Gateway Connection Rotation

**Intent:** Administrators can rotate gateway coordinates or credentials without losing matching route authority.

**Applies To:** Admin

**Acceptance Criteria:**

1. A successful management check after rotating gateway coordinates or credentials preserves saved route authority only when profile and topology still match. <!-- @impl: src/lib/admin-configuration.ts::normalizeAiReasoningConfiguration --> <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (REQ-ENTERPRISE-057: rebinds saved route authority after a replacement connection passes management topology validation) --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-057: a successfully checked credential change preserves saved route authority for Review changes) -->
2. Editing gateway coordinates or credentials preserves and submits matching saved Dynamic Route and native policy selections to Review before a management check. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/EnvironmentIndex.test.tsx (REQ-ENTERPRISE-044/057: connection drafts preserve saved policies before and after checking (%s)) --> <!-- @test: web-ui/src/__tests__/components/EnvironmentIndex.test.tsx (REQ-ENTERPRISE-057: preserves a native-only policy before and after checking connection changes) -->
3. Authoritative preview rebinds retained Dynamic Route authority only when its saved identity and topology still match. <!-- @impl: src/lib/admin-configuration.ts::validateConfigurationValues --> <!-- @impl: src/routes/admin/configuration-previews.ts::app --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (REQ-ENTERPRISE-057: rebinds saved route authority after a replacement connection passes management topology validation) -->
4. Authoritative preview rejects mismatched saved Dynamic Route authority before Save. <!-- @impl: src/lib/admin-configuration.ts::validateConfigurationValues --> <!-- @impl: src/routes/admin/configuration-previews.ts::app --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (rejects a receipt after $identity identity changes (administrator: $administratorConfirmed)) -->

**Constraints:** Rotation neither persists checks nor invokes paid model probes; preview revalidates browser-retained native authority against provider and gateway state.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-017](#req-enterprise-017-ai-gateway-configured-in-the-setup-wizard), [REQ-ENTERPRISE-042](#req-enterprise-042-enterprise-pi-draft-connection-and-verification), [REQ-ENTERPRISE-063](#req-enterprise-063-ai-gateway-management-url-compatibility)

**Verification:** Anchored behavioral fixtures and CI.

**Status:** Implemented

---

### REQ-ENTERPRISE-061: Native Target Administration Projection

**Intent:** Administration can identify native targets without receiving provider authority.

**Applies To:** Admin

**Acceptance Criteria:**

1. Browser projection omits raw provider IDs, credentials, aliases, previews, and token material. <!-- @impl: src/lib/native-ai-targets.ts::sanitizeNativeTarget --> <!-- @test: src/__tests__/lib/native-ai-targets.test.ts (REQ-ENTERPRISE-061: browser projection excludes exact provider authority and aliases) -->

**Constraints:** Projection retains only fields required to administer the target.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-053](models-and-routing.md#req-enterprise-053-native-target-identity-and-document)

**Verification:** Anchored behavioral fixtures and CI.

**Status:** Implemented

---

### REQ-ENTERPRISE-062: AI Gateway Setup Persistence Boundaries

**Intent:** Setup preserves existing gateway credentials on blank input and excludes them outside Enterprise mode.

**Applies To:** Admin

**Acceptance Criteria:**

1. A blank gateway URL preserves the saved URL. <!-- @impl: src/routes/setup/index.ts::app --> <!-- @test: src/__tests__/routes/setup-enterprise-groups.test.ts (REQ-ENTERPRISE-062: a blank AI Gateway URL preserves the stored URL) -->
2. A blank gateway token preserves the saved encrypted token. <!-- @impl: src/routes/setup/index.ts::app --> <!-- @test: src/__tests__/routes/setup-enterprise-groups.test.ts (REQ-ENTERPRISE-062: a blank AI Gateway token leaves the stored token untouched (no clobber)) -->
3. Non-enterprise Setup writes neither gateway coordinate nor token. <!-- @impl: src/routes/setup/index.ts::app --> <!-- @test: src/__tests__/routes/setup-enterprise-groups.test.ts (REQ-ENTERPRISE-062: never writes the AI Gateway keys in non-enterprise mode (regression)) -->

**Constraints:** Blank input never clears saved gateway authority.

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-017](#req-enterprise-017-ai-gateway-configured-in-the-setup-wizard)

**Verification:** Anchored behavioral fixtures and CI.

**Status:** Implemented

---

### REQ-ENTERPRISE-063: AI Gateway Management URL Compatibility

**Intent:** Dynamic Route management operations accept both supported AI Gateway URL forms.

**Applies To:** Admin

**Acceptance Criteria:**

1. Dynamic Route detection accepts legacy and account API gateway URLs. <!-- @impl: src/lib/ai-gateway-management.ts::parseGatewayUrl --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (REQ-ENTERPRISE-057/063: accepts the account API base URL and configured gateway name for Dynamic Route inspection) --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (REQ-ENTERPRISE-057/063: accepts the legacy gateway URL for Dynamic Route inspection) -->
2. Dynamic Route inventory accepts legacy and account API gateway URLs. <!-- @impl: src/lib/ai-gateway-management.ts::parseGatewayUrl --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (REQ-ENTERPRISE-063: loads Dynamic Route inventory through the %s URL) -->
3. Profile discovery accepts legacy and account API gateway URLs. <!-- @impl: src/lib/ai-gateway-management.ts::parseGatewayUrl --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (REQ-ENTERPRISE-057/063: discovers and verifies a Dynamic Route profile through the account API URL) --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (REQ-ENTERPRISE-057/063: discovers and verifies a Dynamic Route profile through the legacy URL) -->
4. Connection checks accept legacy and account API gateway URLs. <!-- @impl: src/lib/ai-gateway-management.ts::parseGatewayUrl --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (REQ-ENTERPRISE-057/063: accepts the account API base URL and configured gateway name for Dynamic Route inspection) --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (REQ-ENTERPRISE-057/063: accepts the legacy gateway URL for Dynamic Route inspection) -->
5. Account API gateway URLs require the gateway name. <!-- @impl: src/lib/ai-gateway-management.ts::parseGatewayUrl --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (rejects invalid draft gateway coordinates, credentials and provenance before external I/O) -->
6. Account API suffixes after the account ID are removed before use. <!-- @impl: src/lib/ai-gateway-management.ts::parseGatewayUrl --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (REQ-ENTERPRISE-057/063: discovers and verifies a Dynamic Route profile through the account API URL) -->
7. Routine Administration returns either saved URL form and its conditional gateway name. <!-- @impl: src/routes/admin/configuration.ts::app --> <!-- @test: src/__tests__/routes/admin-configuration.test.ts (returns enterprise credential sources without exposing secret bytes) -->

**Constraints:** Compatibility does not broaden accepted gateway coordinates.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-042](#req-enterprise-042-enterprise-pi-draft-connection-and-verification)

**Verification:** Anchored behavioral fixtures and CI.

**Status:** Implemented

---

### REQ-ENTERPRISE-064: Route and Compatibility Profile Presentation

**Intent:** Administrators can distinguish Dynamic Routes from Native Routes wherever they configure profiles or grant access.

**Applies To:** Admin

**Acceptance Criteria:**

1. Configured and assignable Dynamic Routes display as `Dynamic Route - <route name>`. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-034/064: presents and preserves named Dynamic Routes in many-to-many group policies) -->
2. Configured and assignable native targets display as `Native Route - <provider> - <user label>`, using the exact model only when the trimmed label is empty or absent. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-064: #110 uses the native label or model fallback in group and fallback policies (%s)) -->
3. Policy submission retains the selected route name or opaque native handle rather than its presentation label. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::PolicyFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-064: #110 uses the native label or model fallback in group and fallback policies (%s)) -->
4. Built-in compatibility profile labels begin with `Dynamic Route` or `Native Route` and identify the provider and supported model family without transport mechanics in the profile name. <!-- @impl: web-ui/src/components/admin/pi-profile-presentation.ts::profileDisplayName --> <!-- @test: web-ui/src/__tests__/components/pi-profile-presentation.test.ts (presents the three Bedrock choices by route category and model family without transport jargon) -->

**Constraints:** Presentation labels do not change route names, profile references, native target identities, or submitted policy values.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-034](#req-enterprise-034-enterprise-pi-route-administration), [REQ-ENTERPRISE-056](#req-enterprise-056-native-target-disclosure-and-readiness)

**Verification:** Regression checkpoint `bef54164` failed in CI `34770156766`. Updated implementation and behavioral fixtures await exact-head CI; no deployed acceptance is claimed.

**Status:** Planned

---

### REQ-ENTERPRISE-066: Native Provider Draft Persistence Before Access

**Intent:** Administrators can establish provider-model configuration before granting runtime access.

**Applies To:** Admin

**Acceptance Criteria:**

1. A complete disabled native provider-model draft can be saved without any Dynamic Route, group assignment, or fallback route. <!-- @impl: src/lib/admin-configuration.ts::validateConfigurationValues --> <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (REQ-ENTERPRISE-066: accepts a disabled native provider target before routes or access policies exist) --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-066: enables Save for a complete disabled native draft without access policies) -->
2. Save remains unavailable while the draft contains an invalid model identifier or context window. <!-- @impl: src/lib/native-ai-target-draft.ts::nativeTargetDraftShapeValid --> <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-066: enables Save for a complete disabled native draft without access policies) -->
3. Save remains unavailable while the draft references a profile absent from the current catalog. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-066: keeps Save unavailable for a native draft whose profile is unavailable) -->
4. Browser validation treats a draft that omits its provider as an AWS Bedrock draft. <!-- @impl: src/lib/native-ai-target-draft.ts::nativeTargetDraftShapeValid --> <!-- @test: src/__tests__/lib/native-ai-targets.test.ts (REQ-ENTERPRISE-066: browser validation treats an omitted provider as AWS Bedrock) -->
5. API validation defaults an omitted draft provider to AWS Bedrock. <!-- @impl: src/lib/native-ai-targets.ts::nativeTargetDraftSchema --> <!-- @test: src/__tests__/lib/native-ai-targets.test.ts (REQ-ENTERPRISE-066: API validation defaults an omitted provider to AWS Bedrock) -->
6. Browser validation rejects undeclared top-level draft fields. <!-- @impl: src/lib/native-ai-target-draft.ts::nativeTargetDraftShapeValid --> <!-- @test: src/__tests__/lib/native-ai-targets.test.ts (REQ-ENTERPRISE-066: browser validation rejects undeclared native draft fields) -->
7. API validation rejects undeclared top-level draft fields. <!-- @impl: src/lib/native-ai-targets.ts::nativeTargetDraftSchema --> <!-- @test: src/__tests__/lib/native-ai-targets.test.ts (REQ-ENTERPRISE-066: API validation rejects undeclared native draft fields) -->

**Constraints:**

- Persisting a disabled draft does not make it eligible for runtime access.
- Provider and profile authority remain Worker-validated.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-044](#req-enterprise-044-enterprise-pi-minimum-save-and-access-policies), [REQ-ENTERPRISE-055](models-and-routing.md#req-enterprise-055-native-target-authority-and-save)

**Verification:** Anchored backend behavioral test; execution is CI-only.

**Status:** Implemented

---

### REQ-ENTERPRISE-067: Enterprise Pi Section Navigation Layout

**Intent:** Administrators can move among gateway configuration sections through a balanced navigation layout at every supported width.

**Applies To:** Admin

**Acceptance Criteria:**

1. At desktop widths, the four gateway configuration sections occupy one balanced navigation row. <!-- @impl: web-ui/src/styles/ai-routing-workspace.css::.admin-routing-nav --> <!-- @manual: On the protected Enterprise Integration deployment at desktop width, confirm all four section controls occupy one row. -->
2. At narrow-screen widths, the four gateway configuration sections form a balanced two-by-two navigation grid. <!-- @impl: web-ui/src/styles/ai-routing-workspace.css::.admin-routing-nav --> <!-- @manual: On the protected Enterprise Integration deployment at mobile width, confirm the section controls form two balanced rows without overflow. -->

**Constraints:**

- Section navigation remains keyboard-operable and preserves configuration drafts.
- The narrow-screen layout does not use horizontal scrolling or a dropdown.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-041](#req-enterprise-041-enterprise-pi-administrator-workspace)

**Verification:** Manual verification on the protected Enterprise Integration deployment.

**Status:** Implemented

---

### REQ-ENTERPRISE-068: Enterprise Pi Connection Control Layout

**Intent:** Administrators can edit gateway connection values through a clear width hierarchy without narrow-screen overflow.

**Applies To:** Admin

**Acceptance Criteria:**

1. At desktop widths, gateway URL and replacement-token inputs receive the primary editing width while format and gateway-name controls remain compact. <!-- @impl: web-ui/src/styles/ai-routing-workspace.css::.admin-connection-fields --> <!-- @manual: On the protected Enterprise Integration deployment at desktop width, compare all four connection controls and confirm the compact and primary hierarchy. -->
2. At narrow-screen widths, all four gateway connection controls stack in one column without horizontal overflow. <!-- @impl: web-ui/src/styles/ai-routing-workspace.css::.admin-connection-fields --> <!-- @manual: On the protected Enterprise Integration deployment at mobile width, confirm the four connection controls use a single-column flow without horizontal overflow. -->

**Constraints:** Connection controls retain the incumbent Administration tokens and accessible labels.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-041](#req-enterprise-041-enterprise-pi-administrator-workspace)

**Verification:** Manual verification on the protected Enterprise Integration deployment.

**Status:** Implemented

---

### REQ-ENTERPRISE-069: Dynamic Route Profile Persistence Before Access

**Intent:** Administrators can save verified Dynamic Route configuration before granting runtime access.

**Applies To:** Admin

**Acceptance Criteria:**

1. A verified Dynamic Route profile assignment can reach Review without a group assignment or fallback route. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-069: enables Review for a verified Dynamic Route profile without an access policy) -->
2. Review and saved summaries include changed inactive route profiles and context windows without granting access. <!-- @impl: web-ui/src/components/admin/AiRoutingReview.tsx::AiRoutingSummary --> <!-- @test: web-ui/src/__tests__/components/EnvironmentIndex.test.tsx (REQ-ENTERPRISE-041: reviews, saves and reloads an inactive administrator-confirmed profile and context without assigning access) -->
3. Preview reports changed inactive assignments and context windows. <!-- @impl: src/lib/admin-configuration.ts::buildConfigurationPreview --> <!-- @test: src/__tests__/routes/admin-configuration-preview.test.ts (REQ-ENTERPRISE-043/069: previews, saves, and reloads an inactive administrator-confirmed Dynamic Bedrock assignment and changed context) -->
4. Save persists inactive assignments and context windows without activating access. <!-- @impl: src/lib/admin-configuration.ts::executeConfigurationTask --> <!-- @test: src/__tests__/routes/admin-configuration-preview.test.ts (REQ-ENTERPRISE-043/069: previews, saves, and reloads an inactive administrator-confirmed Dynamic Bedrock assignment and changed context) -->

5. Semantically unchanged AI routing submissions produce an empty change list, excluding transient receipts and preserved secrets. <!-- @impl: src/lib/admin-configuration.ts::aiRoutingComparison --> <!-- @impl: src/lib/admin-configuration.ts::buildConfigurationPreview --> <!-- @test: src/__tests__/routes/admin-configuration-preview.test.ts (REQ-ENTERPRISE-069: compares stored policy objects with submitted ordered policies without inventing changes) -->
6. Review renders authoritative route-level before/after differences, including removals, rather than the whole submitted inventory. <!-- @impl: web-ui/src/components/admin/AiRoutingReview.tsx::AiRoutingSummary --> <!-- @test: web-ui/src/__tests__/components/AiRoutingReview.test.tsx (REQ-ENTERPRISE-069: shows only the authoritative changed route, not the unchanged configuration inventory) --> <!-- @test: web-ui/src/__tests__/components/AiRoutingReview.test.tsx (REQ-ENTERPRISE-069: shows a removed assignment from the authoritative before state) -->
7. Save rejects an empty AI routing diff before configuration writes or a revision increment. <!-- @impl: src/routes/admin/configuration-runs.ts::app --> <!-- @test: src/__tests__/routes/admin-configuration-preview.test.ts (REQ-ENTERPRISE-043/069: previews, saves, and reloads an inactive administrator-confirmed Dynamic Bedrock assignment and changed context) -->

**Constraints:**

- Saving an inactive route assignment does not grant runtime access.
- Comparison preserves policy priority and trusted verification changes.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-043](models-and-routing.md#req-enterprise-043-enterprise-pi-verified-route-activation), [REQ-ENTERPRISE-044](#req-enterprise-044-enterprise-pi-minimum-save-and-access-policies)

**Verification:** Anchored behavioral fixture; execution is CI-only.

**Status:** Implemented

---

### REQ-ENTERPRISE-081: Authoritative Review Validation Feedback

**Intent:** Administrators receive actionable authoritative reasons when AI routing Review rejects a draft.

**Applies To:** Admin

**Acceptance Criteria:**

1. Preview transport preserves structured field-level validation reasons from the server. <!-- @impl: web-ui/src/api/client.ts::previewConfiguration --> <!-- @test: web-ui/src/__tests__/api/client.test.ts (REQ-ENTERPRISE-081: preserves authoritative preview validation fields in a typed request error) -->
2. Rejected Review displays each non-empty field-level reason once. <!-- @impl: web-ui/src/components/admin/EnvironmentIndex.tsx::configurationErrorMessage --> <!-- @test: web-ui/src/__tests__/components/EnvironmentIndex.test.tsx (REQ-ENTERPRISE-081: shows each non-empty authoritative validation reason once when Review is rejected) -->
3. A non-JSON preview failure retains its actionable server message. <!-- @impl: web-ui/src/api/client.ts::previewConfiguration --> <!-- @test: web-ui/src/__tests__/api/client.test.ts (REQ-ENTERPRISE-081: preserves a plain-text preview failure message) -->

**Constraints:** Feedback exposes only server-returned error messages, never submitted configuration values or credentials.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-044](#req-enterprise-044-enterprise-pi-minimum-save-and-access-policies)

**Verification:** Anchored behavioral fixtures and CI.

**Status:** Implemented

---

### REQ-ENTERPRISE-088: Group-scoped native Pi providers

**Intent:** Administrators explicitly grant or revoke personal Pi provider permission independently of sanctioned Gateway defaults.

**Applies To:** Admin

**Acceptance Criteria:**

1. Administration strictly validates and preserves the default-off permission per group and enabled fallback, including checkbox-only changes and explicit revocation. <!-- @impl: src/lib/admin-configuration.ts::aiRoutingComparison --> <!-- @test: src/__tests__/routes/admin-configuration-preview.test.ts (REQ-ENTERPRISE-088 AC1: checkbox-only group grants and revocations survive preview save and reload) --> <!-- @test: src/__tests__/lib/personal-pi-policy.test.ts (REQ-ENTERPRISE-088 AC1: fallback preserves exact booleans and rejects coercion) -->
2. Accessible group/fallback controls preserve independent submitted permissions without changing sanctioned defaults. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::PolicyFields --> <!-- @test: web-ui/src/__tests__/components/ai-routing-fields-suite.tsx (REQ-ENTERPRISE-088 AC2: group and fallback checkboxes retain independent submitted permissions) -->
3. Review changes communicate personal-provider grants and revocations separately from unchanged sanctioned defaults. <!-- @impl: web-ui/src/components/admin/AiRoutingReview.tsx::AiRoutingReview --> <!-- @test: web-ui/src/__tests__/components/AiRoutingReview.test.tsx (REQ-ENTERPRISE-088 AC3: Review renders $action for $scope without changing sanctioned defaults) -->

**Constraints:**

- Additive `allowPersonalPiProviders`, default off.
- Preserve existing fallback route validation and configured group matching.
- Enterprise human Pi sessions only.
- Fixed native destinations derive from pinned Pi; cloud resource/region families retain network policy, not an arbitrary custom-origin exception.
- Native OpenAI JSON requests are bounded at eight MiB.
- No production deployment, Operator activation or parallel OAuth service.
- Startup permission changes take effect on container restart; request-time policy checks do not rely on picker state.
- Owner authentication follows the deployment's existing storage/governance regime.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-005](models-and-routing.md#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls), [REQ-ENTERPRISE-013](models-and-routing.md#req-enterprise-013-per-group-dynamic-routing), [REQ-ENTERPRISE-016](security.md#req-enterprise-016-strict-gateway-egress), [REQ-ENTERPRISE-058](models-and-routing.md#req-enterprise-058-native-model-container-publication)

**Verification:** Administration and shared editor tests cover persistence/payloads; separate actual Review component regressions cover grant/revocation rendering without changing sanctioned defaults. Test execution and exact-head CI remain unverified; startup/provider/Operator evidence belongs to the siblings below.

**Status:** Implemented

---
