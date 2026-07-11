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

**Verification:** [Integration test](../../src/__tests__/setup-ac-coverage.test.ts)

**Status:** Implemented

---

### REQ-SETUP-002: Setup wizard configures domain, auth, R2 credentials, and Turnstile

**Intent:** A single `POST /api/setup/configure` call provisions all required Cloudflare resources and stores the resulting configuration in Workers KV.

**Applies To:** Admin

**Acceptance Criteria:**

1. The request body includes the custom domain, the user allowlist, the admin allowlist (subset of users), and an optional origin allowlist. <!-- @impl: src/routes/setup/index.ts::ConfigureBodySchema --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-002 AC1: request body requires customDomain (valid domain), allowedUsers (non-empty email array), adminUsers (non-empty email array, subset of allowedUsers)) -->
2. All fields are validated synchronously before streaming starts; invalid input is rejected with a 400 error. <!-- @impl: src/lib/request-helpers.ts::parseJsonBody --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (Setup AC Coverage) -->
3. Setup executes 7 sequential steps and streams per-step progress; the per-step contract for each step and its observable effect lives in [REQ-SETUP-012](#req-setup-012-setup-wizard-step-sequence). <!-- @impl: src/routes/setup/index.ts::default --> <!-- @impl: src/routes/setup/shared.ts::withSetupRetry --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-002 AC3: configure streams per-step progress for all 7 setup steps) -->
4. All persistent state written by setup lives under a dedicated setup namespace. <!-- @impl: src/lib/kv-keys.ts::SETUP_KEYS --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (Setup AC Coverage) -->
5. The response stream ends with exactly one terminal completion object. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-002 AC5: response stream ends with exactly one object containing done: true) -->

**Constraints:**

- Each Cloudflare API call uses exponential backoff (3 total attempts, 1s base delay).
- Circuit-breaker open errors are not retried.

**Priority:** P0

**Dependencies:** [REQ-SETUP-001](#req-setup-001-first-time-setup-requires-zero-pre-configuration)

**Verification:** [Integration test](../../src/__tests__/setup-ac-coverage.test.ts)

**Status:** Implemented

---

### REQ-SETUP-003: Three deployment modes

**Intent:** Codeflare supports three deployment modes that determine authentication strategy and user provisioning.

**Applies To:** Admin

**Acceptance Criteria:**

1. Default mode uses Cloudflare Access authentication with manually allowlisted users via the setup wizard, gated by CF Access policies and a persistent allowlist. <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @test: src/__tests__/routes/setup.test.ts (REQ-SETUP-003: CF Access provisioning gated by isSessionOidcMode + OAUTH_CLIENT_ID) -->
2. Onboarding mode presents a public waitlist landing page for unauthenticated visitors and routes authenticated users into the application; when GitHub OAuth (`OAUTH_CLIENT_ID`) is configured the Worker authenticates via its own GitHub-OIDC session cookie and the setup wizard skips CF Access provisioning. <!-- @impl: src/lib/onboarding.ts::isOnboardingLandingPageActive --> <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) -->
3. SaaS mode replaces the CF Access interstitial with a branded login page; when GitHub OAuth is configured it uses session credentials for authentication, the setup wizard skips CF Access provisioning, and it auto-provisions new users with a pending tier and manages user state without CF Access groups or policies. <!-- @impl: src/lib/onboarding.ts::isSaasModeActive --> <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) -->
4. Deployment mode is determined at deploy time via Worker bindings; the setup wizard skips CF Access provisioning in any session-OIDC mode (SaaS OR onboarding) with `OAUTH_CLIENT_ID` set, and provisions CF Access (groups, app, policy) plus the enterprise vault SW-bypass app otherwise. <!-- @impl: src/lib/onboarding.ts::isSessionOidcMode --> <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) -->
5. The frontend detects the active mode on load and renders the appropriate initial view: branded login for SaaS, setup wizard if unconfigured, or workspace redirect for default mode. <!-- @impl: web-ui/src/App.tsx::checkSetupStatus --> <!-- @test: web-ui/src/__tests__/components/App.test.tsx (App setup routing) -->

**Constraints:**

- Stress-test mode must not be active alongside SaaS mode (returns 503).
- A session-OIDC mode (SaaS or onboarding) without `OAUTH_CLIENT_ID` configured falls back to CF Access authentication, and the setup wizard provisions CF Access for it.
- The CF Access skip mirrors the runtime guard `isSessionOidcMode`, so a session-OIDC deployment never gets a stray Access app that would 302 the credential-less vault service-worker registration ([REQ-VAULT-017](vault.md#req-vault-017-silverbullet-native-service-worker)).

**Priority:** P0

**Dependencies:** [REQ-AUTH-001](authentication.md#req-auth-001-two-authentication-modes)

**Verification:** [Integration test](../../src/__tests__/lib/onboarding.test.ts)

**Status:** Implemented

---

### REQ-SETUP-004: Setup is idempotent

**Intent:** Re-running the setup wizard with the same or updated inputs must safely update existing resources without creating duplicates or leaving orphaned state.

**Applies To:** User

**Acceptance Criteria:**

1. Every step uses create-or-update semantics: reads are non-mutating, derived values are deterministic from the token, secrets overwrite, DNS/route/Access/Turnstile provisioning is upsert-shaped. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) -->
2. If a previous run partially completed, a retry updates existing resources and continues from the first step. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-004 AC2: if previous run partially completed, retry starts from step 1 and updates existing resources) -->
3. Partial progress from failed runs is retained so the next call can resume. Setup is not marked complete on failure. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (Setup AC Coverage) -->
4. "Already exists" errors on Worker routes and DNS records are handled by updating the existing resource rather than failing. <!-- @impl: src/routes/setup/custom-domain.ts::handleConfigureCustomDomain --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-004 AC4: already-exists errors on Worker routes are handled by updating the existing route) -->
5. The "latest version not yet deployed" error class on secret writes triggers an automatic redeploy of the latest Worker version followed by a retry. <!-- @impl: src/routes/setup/secrets.ts::handleSetSecrets --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-004 AC5: error code 10215 on secret write triggers auto-deploy then retry) -->

**Constraints:**

- A persistent lock prevents concurrent configure runs and is released on completion or failure; staleness has an upper bound.
- The lock check returns an immediate error (with no step progress) if another configure run is already active and not yet stale.

**Priority:** P1

**Dependencies:** [REQ-SETUP-002](#req-setup-002-setup-wizard-configures-domain-auth-r2-credentials-and-turnstile)

**Verification:** [Integration test](../../src/__tests__/setup-ac-coverage.test.ts)

**Status:** Implemented

---

### REQ-SETUP-005: Post-setup reconfiguration requires admin auth

**Intent:** After initial setup is complete, only authenticated administrators can reconfigure the deployment.

**Applies To:** Admin

**Acceptance Criteria:**

1. Once setup is marked complete, the setup-route auth middleware requires valid authentication for all configure/detect/prefill endpoints. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (Setup Handlers / REQ-SETUP-005 (admin-only auth gate on POST setup endpoints) / REQ-SETUP-006 (setup config persistence + reload) / REQ-SETUP-008 (setup wizard step state machine and validation) / REQ-SETUP-011 (allowlist persisted as KV user records via setup endpoint)) -->
2. The authenticated principal must have the admin role. <!-- @impl: src/lib/access.ts::authenticateRequest --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (Setup Handlers / REQ-SETUP-005 (admin-only auth gate on POST setup endpoints) / REQ-SETUP-006 (setup config persistence + reload) / REQ-SETUP-008 (setup wizard step state machine and validation) / REQ-SETUP-011 (allowlist persisted as KV user records via setup endpoint)) -->
3. The admin gate applies to the configure endpoint, the token-detection endpoint, and the prefill endpoint. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (Setup Handlers / REQ-SETUP-005 (admin-only auth gate on POST setup endpoints) / REQ-SETUP-006 (setup config persistence + reload) / REQ-SETUP-008 (setup wizard step state machine and validation) / REQ-SETUP-011 (allowlist persisted as KV user records via setup endpoint)) -->
4. The setup-status endpoint remains always public and never returns secrets. <!-- @test: src/__tests__/routes/setup/handlers.test.ts (Setup Handlers / REQ-SETUP-005 (admin-only auth gate on POST setup endpoints) / REQ-SETUP-006 (setup config persistence + reload) / REQ-SETUP-008 (setup wizard step state machine and validation) / REQ-SETUP-011 (allowlist persisted as KV user records via setup endpoint)) -->
5. Authentication accepts either Cloudflare Access tokens or Worker-issued session credentials, verified through the shared auth middleware. <!-- @impl: src/lib/access.ts::authenticateRequest --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (Setup Handlers / REQ-SETUP-005 (admin-only auth gate on POST setup endpoints) / REQ-SETUP-006 (setup config persistence + reload) / REQ-SETUP-008 (setup wizard step state machine and validation) / REQ-SETUP-011 (allowlist persisted as KV user records via setup endpoint)) -->

**Notes:** Manual verification procedures are documented in the [configuration checklist](../../documentation/lanes/configuration.md#manual-verification-checklist).

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

1. The response uses NDJSON as its content type. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) -->
2. Each line is a self-contained JSON object terminated by a newline. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) -->
3. Progress messages identify the step and report one of: running, succeeded, or failed. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (Setup AC Coverage) -->
4. Failure messages include a human-readable error description. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: web-ui/src/__tests__/stores/setup.test.ts (configure) -->
5. Every stream ends with exactly one terminal completion object that carries the overall success flag. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (Setup AC Coverage) -->

**Constraints:**

- The stream is not retryable mid-progress; on failure the client must re-submit the full request.
- The exact terminal-completion payload shape and edge-case behavior is specified in [REQ-SETUP-011](#req-setup-011-setup-stream-completion-payload-contract).

**Priority:** P1

**Dependencies:** [REQ-SETUP-002](#req-setup-002-setup-wizard-configures-domain-auth-r2-credentials-and-turnstile)

**Verification:** [Automated test](../../src/__tests__/routes/setup/handlers.test.ts)

**Status:** Implemented

---

### REQ-SETUP-007: Custom domain with DNS validation

**Intent:** The setup wizard must configure a custom domain with proper DNS records and Worker routes, supporting nested subdomains and ccTLDs.

**Applies To:** Admin

**Acceptance Criteria:**

1. Zone resolution walks progressively shorter suffixes of the requested hostname so multi-label TLDs are handled correctly. <!-- @impl: src/routes/setup/custom-domain.ts::handleConfigureCustomDomain --> <!-- @test: src/__tests__/setup-007-custom-domain-ac.test.ts (REQ-SETUP-007 AC1: zone resolution tries progressively shorter domain suffixes to support ccTLDs) -->
2. A proxied CNAME record is created or updated, pointing the custom domain at the Worker's default workers.dev hostname. <!-- @impl: src/routes/setup/custom-domain.ts::handleConfigureCustomDomain --> <!-- @test: src/__tests__/setup-007-custom-domain-ac.test.ts (REQ-SETUP-007 AC2: proxied CNAME record is created pointing custom domain to workers.dev target) -->
3. A Worker route covering the custom domain is created and mapped to the deployed Worker script. <!-- @impl: src/routes/setup/custom-domain.ts::handleConfigureCustomDomain --> <!-- @test: src/__tests__/setup-007-custom-domain-ac.test.ts (REQ-SETUP-007 AC3: Worker route pattern {customDomain}/* is created mapped to the worker script) -->
4. "Already exists" errors on Worker routes are handled by updating the existing route rather than failing. <!-- @impl: src/routes/setup/custom-domain.ts::handleConfigureCustomDomain --> <!-- @test: src/__tests__/setup-007-custom-domain-ac.test.ts (REQ-SETUP-007 AC4: already-exists errors on Worker routes are handled by updating the existing route) -->
5. The custom domain is persisted in normalized (lowercased) form so origin comparisons are deterministic. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/setup-007-custom-domain-ac.test.ts (REQ-SETUP-007 AC5: custom domain is stored in KV as setup:custom_domain (lowercased)) -->
6. Dynamic origins (the custom domain plus any additional origins configured via setup) are cached in-memory for a short TTL; the persistent store is the source of truth. <!-- @impl: src/lib/cors-cache.ts::isAllowedOrigin --> <!-- @test: src/__tests__/lib/cors-cache.test.ts (cors-cache / REQ-SETUP-007 (custom-domain CORS cache invalidation)) -->
7. After setup completes, the workers.dev hostname is treated as an initialization-only fallback; production traffic flows through the custom domain. <!-- @impl: src/routes/setup/custom-domain.ts::handleConfigureCustomDomain --> <!-- @test: src/__tests__/setup-007-custom-domain-ac.test.ts (REQ-SETUP-007 AC2: proxied CNAME record is created pointing custom domain to workers.dev target) -->

**Constraints:**

- The custom-domain zone must be managed by Cloudflare for DNS provisioning to succeed.
- The CNAME record is Cloudflare-proxied so the origin address is not exposed.

**Priority:** P1

**Dependencies:** [REQ-SETUP-002](#req-setup-002-setup-wizard-configures-domain-auth-r2-credentials-and-turnstile)

**Verification:** [Integration test](../../src/__tests__/setup-007-custom-domain-ac.test.ts)

**Status:** Implemented

---

### REQ-SETUP-008: Setup helper endpoints support prefill and detection

**Intent:** The setup UI must be able to pre-populate fields from existing configuration and detect the API token's capabilities.

**Applies To:** Admin

**Acceptance Criteria:**

1. The prefill endpoint reads existing CF Access group membership and persistent configuration so the setup form repopulates correctly on redeployment. <!-- @impl: src/routes/setup/handlers.ts::default --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (Setup Handlers / REQ-SETUP-005 (admin-only auth gate on POST setup endpoints) / REQ-SETUP-006 (setup config persistence + reload) / REQ-SETUP-008 (setup wizard step state machine and validation) / REQ-SETUP-011 (allowlist persisted as KV user records via setup endpoint)) -->
2. The token-detection endpoint validates the API token and returns its capabilities (account info, permissions). <!-- @impl: src/routes/setup/handlers.ts::default --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (GET /detect-token) -->
3. Both helper endpoints share the same rate limiter as the configure endpoint, so they cannot bypass setup-route throttling. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
4. Both endpoints require admin auth after setup is complete, using the same conditional gate as the configure endpoint. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (Setup Handlers / REQ-SETUP-005 (admin-only auth gate on POST setup endpoints) / REQ-SETUP-006 (setup config persistence + reload) / REQ-SETUP-008 (setup wizard step state machine and validation) / REQ-SETUP-011 (allowlist persisted as KV user records via setup endpoint)) -->

**Constraints:**

- Prefill is read-only: it never writes to the Cloudflare API or persistent state.
- Token detection is a read-only validation and never provisions resources.

**Priority:** P1

**Dependencies:** [REQ-SETUP-005](#req-setup-005-post-setup-reconfiguration-requires-admin-auth)

**Verification:** [Automated test](../../src/__tests__/routes/setup/handlers.test.ts)

**Status:** Implemented

---

### REQ-SETUP-009: Subscribe page with tier selection

**Intent:** Users can choose their subscription tier with a clear comparison of features and pricing.

**Applies To:** User

**Acceptance Criteria:**

1. The subscribe page shows the available tiers with their features, included hours, session limits, storage, and pricing. <!-- @impl: web-ui/src/components/SubscribePage.tsx::SubscribePage --> <!-- @test: web-ui/src/__tests__/components/SubscribePage.test.tsx (SubscribePage / REQ-SETUP-009 (subscribe page redirect for pending users) / REQ-SUB-017 (tier selection UI)) -->
2. The flow is a two-phase wizard: an overview phase and a tier-selection phase; checkout is an external payment-provider handoff, not an internal phase. <!-- @impl: web-ui/src/components/SubscribePage.tsx::SubscribePage --> <!-- @test: web-ui/src/__tests__/components/SubscribePage.test.tsx (SubscribePage / REQ-SETUP-009 (subscribe page redirect for pending users) / REQ-SUB-017 (tier selection UI)) -->
3. New subscriptions are gated by a CAPTCHA challenge. <!-- @impl: web-ui/src/components/SubscribePage.tsx::SubscribePage --> <!-- @test: web-ui/src/__tests__/components/SubscribePage.test.tsx (REQ-SETUP-009 AC3: Turnstile CAPTCHA is initialized for pending users when turnstileSiteKey is provided) -->
4. The page exposes a mode toggle between the two subscription mode families. <!-- @impl: web-ui/src/components/SubscribePage.tsx::SubscribePage --> <!-- @test: web-ui/src/__tests__/components/SubscribePage.test.tsx (SubscribePage / REQ-SETUP-009 (subscribe page redirect for pending users) / REQ-SUB-017 (tier selection UI)) -->
5. The free tier activates immediately without an external checkout step. <!-- @impl: web-ui/src/components/SubscribePage.tsx::SubscribePage --> <!-- @test: web-ui/src/__tests__/components/SubscribePage.test.tsx (REQ-SETUP-009 AC5: free tier activates immediately via subscribe API call (no Stripe checkout)) -->
6. Paid tiers hand off to the external payment provider's hosted checkout. <!-- @impl: web-ui/src/components/SubscribePage.tsx::SubscribePage --> <!-- @test: web-ui/src/__tests__/components/SubscribePage.test.tsx (REQ-SETUP-009 AC6: paid tiers show "Start Trial" CTA indicating Stripe checkout path) -->

**Constraints:** None.

**Priority:** P1

**Dependencies:** [REQ-SUB-001](subscription.md#req-sub-001-eight-tier-subscription-system)

**Verification:** [Integration test](../../web-ui/src/__tests__/components/SubscribePage.test.tsx)

**Status:** Implemented

---

### REQ-SETUP-010: Social-share preview metadata on the public landing page

**Intent:** When the public-facing URL is shared on social platforms or chat apps, the unfurl renders a branded preview card with the product tagline and a 1200x630 preview image so the link communicates what Codeflare is before the visitor clicks.

**Applies To:** User

**Acceptance Criteria:**

1. The home page exposes Open Graph metadata: `og:type`, `og:site_name`, `og:title`, `og:description`, `og:url`, `og:image`, `og:image:width=1200`, `og:image:height=630`, `og:image:alt`, `og:locale`. <!-- @impl: web-ui/index.html::og:image:alt --> <!-- @test: web-ui/src/__tests__/setup-010-og-metadata.test.ts (REQ-SETUP-010: Social-share preview metadata on the public landing page) -->
2. Twitter Card metadata is set with `twitter:card="summary_large_image"` plus title, description, image, and image:alt. <!-- @impl: web-ui/index.html::format-detection --> <!-- @test: web-ui/src/__tests__/setup-010-og-metadata.test.ts (AC2: Twitter Card metadata is set (scraper view)) -->
3. The preview image is a 1200x630 PNG that includes the Codeflare wordmark, the product tagline, and a CODEFLARE.CH wordmark footer. <!-- @test: web-ui/src/__tests__/setup-010-og-metadata.test.ts (AC3: 1200x630 PNG preview image is referenced (parsed values)) -->
4. The `<meta name="description">` extends the `og:description` (it begins with the same canonical share copy and appends a short product descriptor) so search-engine snippets and social-share cards stay aligned. <!-- @test: web-ui/src/__tests__/setup-010-og-metadata.test.ts (REQ-SETUP-010: Social-share preview metadata on the public landing page) -->

**Notes:** Manual verification procedures are documented in the [configuration checklist](../../documentation/lanes/configuration.md#manual-verification-checklist).

**Constraints:**

- The preview image must remain <=1MB so platforms cache it inline.
- og:image dimensions are 1200x630 (the dual standard for Open Graph and Twitter `summary_large_image` cards).

**Priority:** P2

**Dependencies:** None.

**Verification:** Manual check

**Status:** Implemented

---

### REQ-SETUP-011: Setup stream completion payload contract

**Intent:** The terminal `done: true` object in the NDJSON stream must carry enough information for the client to render the final outcome and chain into post-setup flows (success URL display, lock-contention retry guidance, error surfacing).

**Applies To:** User

**Acceptance Criteria:**

1. Successful completion carries the cumulative per-step status list, the workers.dev URL, and the custom-domain URL. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (Setup AC Coverage) -->
2. Failed completion carries the cumulative per-step status list plus a top-level error description. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
3. Lock contention produces an immediate terminal completion with success=false and no intervening step progress messages. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (Setup Handlers / REQ-SETUP-005 (admin-only auth gate on POST setup endpoints) / REQ-SETUP-006 (setup config persistence + reload) / REQ-SETUP-008 (setup wizard step state machine and validation) / REQ-SETUP-011 (allowlist persisted as KV user records via setup endpoint)) -->
4. Clients detect completion by parsing stream entries until the terminal completion marker, then read the success flag. <!-- @impl: web-ui/src/stores/setup.ts::setupStore --> <!-- @test: web-ui/src/__tests__/stores/setup.test.ts (Setup Store) -->

**Constraints:**

- The per-step status list in the completion object is cumulative across all attempted steps.

**Priority:** P1

**Dependencies:** [REQ-SETUP-006](#req-setup-006-setup-streams-progress-via-ndjson)

**Verification:** [Automated test](../../src/__tests__/routes/setup/handlers.test.ts)

**Status:** Implemented

---

### REQ-SETUP-012: Setup wizard step sequence

**Intent:** The setup wizard's 7-step pipeline must run in a fixed order, each step has a stable identifier the NDJSON stream emits, and the per-step observable effect is enforced as a separate contract so a regression in one step does not silently break the next.

**Applies To:** Admin

**Acceptance Criteria:**

1. Step 1 retrieves the Cloudflare account ID from the API token. <!-- @impl: src/routes/setup/account.ts::handleGetAccount --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-012 AC1: step get_account retrieves account ID from the API token) -->
2. Step 2 derives R2-compatible credentials deterministically from the API token. <!-- @impl: src/routes/setup/credentials.ts::handleDeriveR2Credentials --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-012 AC2: step derive_r2_credentials uses token ID as Access Key ID and SHA-256 of token as Secret) -->
3. Step 3 stores the R2 access credentials as Worker secrets. <!-- @impl: src/routes/setup/secrets.ts::handleSetSecrets --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-012 AC3: step set_secrets sets R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY as Worker secrets) -->
4. On reconfigure, stale users removed from the allowlist are cleaned up before continuing. <!-- @impl: src/lib/user-cleanup.ts::cleanupUserData --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-012 AC4: step cleanup_stale_users runs only on reconfigure when users removed from allowlist) -->
5. Step 4 configures the custom domain by upserting the DNS record and Worker route. <!-- @impl: src/routes/setup/custom-domain.ts::handleConfigureCustomDomain --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-012 AC5: step configure_custom_domain creates CNAME DNS record and Worker route) -->
6. Step 5 upserts the CF Access application, groups, and policies; this step is bypassed when an OAuth client ID is configured (the SaaS OAuth path per AD38), not unconditionally in SaaS mode. <!-- @impl: src/routes/setup/access.ts::handleCreateAccessApp --> <!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-012 AC6: step create_access_app creates CF Access application and is skipped in GitHub OIDC mode) -->
7. Step 6 provisions a Turnstile widget when onboarding or SaaS mode is active; Step 7 writes final state and marks setup complete. <!-- @test: src/__tests__/setup-ac-coverage.test.ts (Setup AC Coverage) -->

**Notes:** Manual verification procedures are documented in the [configuration checklist](../../documentation/lanes/configuration.md#manual-verification-checklist).

**Constraints:**

- Step ordering is fixed; steps may not be reordered without a spec change.

**Priority:** P0

**Dependencies:** [REQ-SETUP-002](#req-setup-002-setup-wizard-configures-domain-auth-r2-credentials-and-turnstile)

**Verification:** Manual check

**Status:** Implemented
