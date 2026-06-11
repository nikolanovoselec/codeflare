# Landing

Public enterprise marketing landing page (codeflare.ch), its mode-aware serving, and the demo-request contact pipeline.

**Domain owner:** Landing app (landing/), Worker root serving (src/index.ts), public routes (src/routes/public/)

### Key Concepts

| Concept | Definition |
|---------|-----------|
| Landing app | A prerendered Astro site built into `web-ui/dist/landing/` and served through the existing assets binding — no separate deployment |
| Public surface | The unauthenticated marketing surface, active only in SaaS and onboarding modes; default and enterprise deployments never expose it |
| Contact relay | Demo-request submissions are Turnstile-verified and relayed to admin users as email (Resend); message content is never persisted |

### Out of Scope

- **Pricing/tier display** -- the landing is enterprise-positioned; self-serve tiers belong to the SaaS instance's subscribe flow ([REQ-SETUP-009](setup.md#req-setup-009-subscribe-page-with-tier-selection)).
- **CRM integration** -- contact submissions go to admin email only; no external CRM systems.

### Domain Dependencies

| Domain | Dependency |
|--------|-----------|
| Setup | Turnstile keys provisioned by the setup wizard are reused for the contact form ([REQ-SETUP-002](setup.md#req-setup-002-setup-wizard-configures-domain-auth-r2-credentials-and-turnstile)) |
| Security | Rate limiting on public submissions ([REQ-SEC-007](security.md#req-sec-007-rate-limiting-infrastructure)); security headers on all landing documents |
| Authentication | Authenticated users at `/` bypass the landing and land in the app ([REQ-AUTH-008](authentication.md#req-auth-008-session-cookie-auto-refresh)) |

---

<!-- @impl: src/index.ts -->
<!-- @impl: landing/src/pages/index.astro -->
<!-- @impl: wrangler.toml -->
<!-- @test: src/__tests__/index.test.ts (REQ-LANDING-001 its -> AC1 SaaS-unauth landing rewrite + AC2 onboarding-unauth landing rewrite + AC3 default-mode redirect) -->
<!-- @test: landing/src/__tests__/index-page.test.ts (REQ-LANDING-001 describe -> AC4 sections/nav/terminal/preflight/form render) -->
### REQ-LANDING-001: Mode-aware public landing serving

**Intent:** Unauthenticated visitors to the deployment root in SaaS or onboarding mode see the enterprise marketing landing page — positioning Codeflare as the enterprise agentic coding engine — while authenticated users and default-mode deployments keep their existing app entry flow.

**Applies To:** User

**Acceptance Criteria:**

1. An unauthenticated GET `/` in SaaS mode is served the prerendered landing app (the asset request is rewritten to `/landing/`).
2. An unauthenticated GET `/` in onboarding mode is served the same landing app.
3. In default mode, GET `/` redirects to `/app/` and the landing is never served.
4. The landing renders the full enterprise narrative statically (no JS required): hero with terminal demo transcript and fleet panes, preflight boot assertions, all pillar sections with anchor ids matching the nav links, FAQ, and the contact form.

**Constraints:**

- Authenticated-user behavior at `/` is unchanged: active users redirect to `/app/`, pending/blocked SaaS users to `/app/subscribe`.
- If the landing build is absent from assets, SPA `not_found_handling` falls back to the legacy in-SPA pages (LoginPage / OnboardingLanding) — deploys without the landing build degrade gracefully, never 404.
- `/landing/*` is listed in `run_worker_first` so landing documents carry the same security headers as `/`.
- The landing build outputs to `web-ui/dist/landing/` and must build after web-ui (which wipes `dist/`).

**Priority:** P1

**Dependencies:** None.

**Verification:** [Worker serving tests](../../src/__tests__/index.test.ts), [Landing render tests](../../landing/src/__tests__/index-page.test.ts)

**Status:** Implemented

---

<!-- @impl: src/routes/public/index.ts -->
<!-- @impl: src/lib/contact-topics.ts -->
<!-- @impl: landing/src/scripts/contact-controller.ts -->
<!-- @test: src/__tests__/routes/public-contact.test.ts (REQ-LANDING-002 describe -> AC1 validation + AC2 mode gating + AC3 turnstile + AC4 email relay/escaping + AC5 no persistence + AC6 contact-config + waitlist-gate regression) -->
<!-- @test: landing/src/__tests__/contact-controller.test.ts (payload building + submission outcomes) -->
### REQ-LANDING-002: Demo-request contact pipeline

**Intent:** Enterprise prospects submit demo requests from the landing page through an abuse-protected endpoint that relays to the operators without storing personal data, keeping the landing's privacy promise ("not stored") literally true.

**Applies To:** User

**Acceptance Criteria:**

1. POST `/public/contact` validates name (1-100), email, company (optional, ≤200), topic (shared `CONTACT_TOPICS` enum), and message (10-4000); invalid input is rejected with 400.
2. The endpoint is available when SaaS mode or onboarding mode is active and returns 404 otherwise; the waitlist endpoint stays onboarding-only.
3. Submissions require a passing Turnstile verification; failures are rejected with a CAPTCHA validation error.
4. Accepted submissions are relayed as email to all admin users with reply-to set to the submitter, and every user-controlled field is HTML-escaped before rendering into the email body.
5. Submission content is never persisted — the only KV writes on the contact path are rate-limiter bookkeeping.
6. GET `/public/contact-config` exposes the Turnstile site key under the same mode gate, for the landing form widget.

**Constraints:**

- Rate-limited (5/minute per client) via the shared KV rate-limiter infrastructure ([REQ-SEC-007](security.md#req-sec-007-rate-limiting-infrastructure)).
- Topic values live in `src/lib/contact-topics.ts`, imported by both the Worker schema and the landing form — the form cannot offer a topic the API rejects.
- Returns 503 when Turnstile/Resend secrets or admin recipients are not configured (same degradation contract as the waitlist).

**Priority:** P1

**Dependencies:** [REQ-LANDING-001](#req-landing-001-mode-aware-public-landing-serving)

**Verification:** [Contact route tests](../../src/__tests__/routes/public-contact.test.ts), [Controller tests](../../landing/src/__tests__/contact-controller.test.ts)

**Status:** Implemented

---

<!-- @impl: landing/src/layouts/BaseLayout.astro -->
<!-- @test: landing/src/__tests__/index-page.test.ts (REQ-LANDING-003 describe -> AC1 OG tag set + AC2 Twitter card + AC3 canonical + AC4 enterprise description) -->
### REQ-LANDING-003: Landing social-share and search metadata

**Intent:** When codeflare.ch is shared or indexed, the unfurl and search snippet communicate the enterprise agentic-coding-engine positioning with a branded preview card.

**Applies To:** User

**Acceptance Criteria:**

1. The landing exposes the full Open Graph set: `og:type`, `og:site_name`, `og:title`, `og:description`, `og:url`, `og:image` (1200x630 with type/alt), `og:locale`.
2. Twitter Card metadata is set with `summary_large_image` plus title, description, image, and image alt.
3. The canonical URL is the served root (`https://codeflare.ch/`), not the `/landing/` asset path.
4. The meta description and OG description carry the enterprise positioning ("enterprise agentic coding engine") as the canonical external description of the product.

**Constraints:**

- The preview image is the existing brand asset (`web-ui/public/og.png`) served from the SPA asset root; replacing it with enterprise-specific artwork is a content task, not a serving change.
- [REQ-SETUP-010](setup.md#req-setup-010-social-share-preview-metadata-on-the-public-landing-page) continues to govern the SPA's own metadata (`web-ui/index.html`), which still serves `/app` and `/login`.

**Priority:** P2

**Dependencies:** [REQ-LANDING-001](#req-landing-001-mode-aware-public-landing-serving)

**Verification:** [Metadata render tests](../../landing/src/__tests__/index-page.test.ts)

**Status:** Implemented
