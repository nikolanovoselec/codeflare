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
<!-- @impl: landing/src/scripts/scramble.ts -->
<!-- @impl: landing/src/scripts/splash.ts -->
<!-- @impl: landing/src/lib/splash-cursor-logic.ts -->
<!-- @impl: landing/src/scripts/proof.ts -->
<!-- @impl: landing/src/scripts/agentfoot.ts -->
<!-- @impl: landing/src/content/site.ts -->
<!-- @impl: wrangler.toml -->
<!-- @test: src/__tests__/index.test.ts (REQ-LANDING-001 its -> AC1 SaaS-unauth landing rewrite + AC2 onboarding-unauth landing rewrite + AC3 default-mode redirect) -->
<!-- @test: landing/src/__tests__/index-page.test.ts (REQ-LANDING-001 describe -> AC4 hero/terminal (governed-run transcript: t-warn drift + t-deny egress + alignment refrain)/spine strip/nav/feature-terminal grid (shift section: tile titles + lines + caption feet)/hero terminal statusline foot (agentfoot: ctx + model + reason)/method self-healing enforcement gate (is-fail/is-pass) + numbered clauses/security boundary denied-list + egress-inspection strip (is-redact DLP)/operations section/context browser-isolated ingestion/parallel review board + dispatch/cost ledger + sample note/totals/FAQ/form/launch path Sign in) -->
### REQ-LANDING-001: Mode-aware public landing serving

**Intent:** Unauthenticated visitors to the deployment root in SaaS or onboarding mode see the enterprise marketing landing page — positioning Codeflare as the enterprise agentic coding engine — while authenticated users and default-mode deployments keep their existing app entry flow.

**Applies To:** User

**Acceptance Criteria:**

1. An unauthenticated GET `/` in SaaS mode is served the prerendered landing app (the asset request is rewritten to `/landing/`).
2. An unauthenticated GET `/` in onboarding mode is served the same landing app.
3. In default mode, GET `/` redirects to `/app/` and the landing is never served.
4. The landing renders the full enterprise narrative statically (no JS required): a hero with a single legible terminal demo whose transcript follows one governed run (a spec drift caught and corrected, a denied direct-provider egress, the "specification, implementation and documentation aligned" refrain) carrying an agent statusline foot (context, model, reasoning level) and a spine strip naming that run; a feature-terminal grid in the shift section (four compact terminals, each showing one codeflare capability as a real command and its output with a one-line caption foot, replacing the former stat band and checkmark comparison); a spec-driven-development "method" section presenting SDD/TDD enforcement as a self-healing enforcement gate; a security section whose boundary data-path, equal-weight denied-paths list, and egress-inspection strip make zero-trust, DLP, and guardrails auditable; a browser-isolation context pipe; a parallel review board; a cost attribution ledger; all content sections with anchor ids matching the nav links; FAQ; the contact form; and a Sign in action (nav and footer) linking to the login provider-chooser (`/login`, `APP_LINKS.signIn`). The governance sections carry the page; the platform-capability sections follow as the payoff the boundary makes safe.

**Constraints:**

- Authenticated-user behavior at `/` is unchanged: active users redirect to `/app/`, pending/blocked SaaS users to `/app/subscribe`. The landing's Sign in link (`APP_LINKS.signIn`, resolves to `/login`) goes directly to the SPA login provider-chooser, an existing route, bypassing the `/app/` redirect that previously returned an unauthenticated visitor to the landing before the login UI rendered.
- If the landing build is absent from assets, SPA `not_found_handling` falls back to the legacy in-SPA pages (LoginPage / OnboardingLanding) — deploys without the landing build degrade gracefully, never 404.
- `/landing/*` is listed in `run_worker_first` so landing documents carry the same security headers as `/`.
- The landing build outputs to `web-ui/dist/landing/` and must build after web-ui (which wipes `dist/`).
- Client JS is enhancement-only: the hero accent-word scramble, the page-wide flare-fluid signature (a fixed full-page WebGL layer driven by the cursor on desktop and by page scroll on touch, paused on a hidden tab, veiled to stay legible behind text), the one-shot proof-artifact sequences armed on scroll-in (the self-healing enforcement gate, the boundary data-path, the egress-inspection strip, the browser-isolation context pipe, the parallel review board, the cost attribution ledger; each artifact ships its resolved final state in the markup so content is never gated), and the scroll-reveal fades are all gated on `prefers-reduced-motion` and absent without JS; the full narrative renders statically.
- The proof artifacts are bound to one spine run (`REQ-PAY-014` / `AC3` / `PR #207`, user `a.chen`, team `payments`; a fictional example run shown as on-page copy, not a requirement this codebase governs), sourced once in `site.ts` so the IDs cannot drift between the hero transcript, the enforcement gate, the egress-inspection strip, the review board, and the cost ledger. The boundary data-path and the browser-isolation context pipe are structural diagrams rendered alongside them, not ID-keyed to the spine.

**Priority:** P1

**Dependencies:** None.

**Verification:** [Worker serving tests](../../src/__tests__/index.test.ts), [Landing render tests](../../landing/src/__tests__/index-page.test.ts)

**Status:** Implemented

---

<!-- @impl: src/routes/public/index.ts -->
<!-- @impl: src/lib/contact-topics.ts -->
<!-- @impl: landing/src/scripts/contact-controller.ts -->
<!-- @test: src/__tests__/routes/public-contact.test.ts (REQ-LANDING-002 describe -> AC1 validation + AC2 mode gating + AC3 turnstile + AC4 email relay/escaping + AC5 no persistence + AC6 contact-config + waitlist-gate regression) -->
<!-- @test: landing/src/__tests__/contact-controller.test.ts (REQ-LANDING-002 describe -> client payload building + submission outcomes) -->
<!-- @test: landing/src/__tests__/index-page.test.ts (privacy page (REQ-LANDING-002) describe -> AC5 no-storage disclosure renders) -->
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
