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

### REQ-LANDING-001: Mode-aware public landing serving

**Intent:** Unauthenticated visitors to the deployment root in SaaS or onboarding mode see the enterprise marketing landing page — positioning Codeflare as the agentic engineering engine — while authenticated users and default-mode deployments keep their existing app entry flow.

**Applies To:** User

**Acceptance Criteria:**

1. An unauthenticated GET `/` in SaaS mode is served the prerendered landing app (the asset request is rewritten to `/landing/`). <!-- @impl: src/index.ts::default --> <!-- @test: src/__tests__/index.test.ts (REQ-LANDING-001: serves the static landing at / when onboarding mode is active (unauthenticated)) -->
2. An unauthenticated GET `/` in onboarding mode is served the same landing app. <!-- @impl: src/index.ts::default --> <!-- @test: src/__tests__/index.test.ts (REQ-LANDING-001: serves the static landing at / when onboarding mode is active (unauthenticated)) -->
3. In default mode, GET `/` redirects to `/app/` and the landing is never served. <!-- @impl: src/index.ts::default --> <!-- @test: src/__tests__/index.test.ts (REQ-LANDING-001: keeps redirecting / to /app in default mode (no landing)) -->
4. The static page composes the typed content model into the ordered enterprise narrative, shared proof terminals, folded substations, orchestration, cost, platform, governance, dogfood, FAQ, and contact surfaces without requiring JavaScript. <!-- @impl: landing/src/pages/index.astro::gate-req --> <!-- @test: landing/src/__tests__/index-page.test.ts (landing page composition (REQ-LANDING-001)) -->
5. Client enhancements animate terminal proofs, capability text, orchestration, reveals, and the page flare while preserving the complete server-rendered resting state and honoring reduced-motion preferences. <!-- @test: landing/src/__tests__/scramble.script.test.ts (scramble.ts (REQ-LANDING-001)) -->
6. Sections use shared composition components and centrally controlled typography, spacing, terminal chrome, responsive breakpoints, and visual hierarchy so peer and subordinate content remain distinguishable at every viewport. <!-- @test: landing/src/__tests__/components.test.ts (Terminal (shared chrome)) -->
7. Navigation, trust links, disclosure content, demo contact, sign-in, and footer controls retain valid destinations, keyboard access, and responsive layouts. <!-- @test: landing/src/__tests__/index-page.test.ts (grids, chips, nav, social proof, faq) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Authenticated visitors retain the app and subscription redirects; unauthenticated sign-in routes directly to the provider chooser.
- Landing assets build after the web UI, fall back to the legacy app when absent, and receive the root document's security headers.
- User-facing marketing copy stays platform-neutral except for relationship-neutral trust marks and functional third-party resources.
- Responsive, motion, typography, spacing, terminal, and enhancement mechanisms are documented in [architecture.md](../../documentation/lanes/architecture.md#landing-composition-implementation).

**Priority:** P1

**Dependencies:** None.

**Verification:** Manual check

**Status:** Implemented

---

### REQ-LANDING-002: Demo-request contact pipeline

**Intent:** Enterprise prospects submit demo requests from the landing page through an abuse-protected endpoint that relays to the operators without storing personal data, keeping the landing's privacy promise ("not stored") literally true.

**Applies To:** User

**Acceptance Criteria:**

1. POST `/public/contact` validates name (1-100), email, company (optional, ≤200), topic (shared `CONTACT_TOPICS` enum), and message (10-4000); invalid input is rejected with 400. <!-- @impl: src/lib/contact-topics.ts::CONTACT_TOPICS --> <!-- @test: src/__tests__/routes/public-contact.test.ts (Public contact route (REQ-LANDING-002)) -->
2. The endpoint is available when SaaS mode or onboarding mode is active and returns 404 otherwise; the waitlist endpoint stays onboarding-only. <!-- @test: src/__tests__/routes/public-contact.test.ts (Public contact route (REQ-LANDING-002)) -->
3. Submissions require a passing Turnstile verification; failures are rejected with a CAPTCHA validation error. <!-- @impl: src/routes/public/index.ts::requireOnboardingMode --> <!-- @test: src/__tests__/routes/public-contact.test.ts (Public contact route (REQ-LANDING-002)) -->
4. Accepted submissions are relayed as email to all admin users with reply-to set to the submitter, and every user-controlled field is HTML-escaped before rendering into the email body. <!-- @test: src/__tests__/routes/public-contact.test.ts (Public contact route (REQ-LANDING-002)) -->
5. Submission content is never persisted — the only KV writes on the contact path are rate-limiter bookkeeping. <!-- @test: src/__tests__/routes/public-contact.test.ts (Public contact route (REQ-LANDING-002)) -->
6. GET `/public/contact-config` exposes the Turnstile site key under the same mode gate, for the landing form widget. <!-- @impl: src/routes/public/index.ts::ContactRequestSchema --> <!-- @test: src/__tests__/routes/public-contact.test.ts (returns the Turnstile site key in SaaS mode) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Rate-limited (5/minute per client) via the shared KV rate-limiter infrastructure ([REQ-SEC-007](security.md#req-sec-007-rate-limiting-infrastructure)).
- Topic values live in `src/lib/contact-topics.ts`, imported by both the Worker schema and the landing form — the form cannot offer a topic the API rejects.
- Returns 503 when Turnstile/Resend secrets or admin recipients are not configured (same degradation contract as the waitlist).

**Priority:** P1

**Dependencies:** [REQ-LANDING-001](#req-landing-001-mode-aware-public-landing-serving)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-LANDING-003: Landing social-share and search metadata

**Intent:** When codeflare.ch is shared or indexed, the unfurl and search snippet communicate the agentic-engineering-engine positioning with a branded preview card, structured data, and root discoverability documents, while private (default/enterprise) deployments stay out of the index.

**Applies To:** User

**Acceptance Criteria:**

1. The landing exposes the full Open Graph set: `og:type`, `og:site_name`, `og:title`, `og:description`, `og:url`, `og:image` (1200x630 with type/alt), `og:locale`. <!-- @impl: landing/src/layouts/BaseLayout.astro::og:description --> <!-- @test: landing/src/__tests__/metadata.test.ts (REQ-LANDING-003 AC1: emits the Open Graph meta tags with their contract values) -->
2. Twitter Card metadata is set with `summary_large_image` plus title, description, image, and image alt. <!-- @impl: landing/src/layouts/BaseLayout.astro::flare-field --> <!-- @test: landing/src/__tests__/metadata.test.ts (REQ-LANDING-003 AC2: emits the Twitter Card meta tags) -->
3. The canonical URL is the served root (`https://codeflare.ch/`), not the `/landing/` asset path. <!-- @impl: landing/src/layouts/BaseLayout.astro::title --> <!-- @test: landing/src/__tests__/metadata.test.ts (REQ-LANDING-003 AC3: emits a canonical link with a non-empty href) -->
4. The social-share card and structured data carry the product's canonical positioning phrase, "agentic engineering engine": the OG image tagline (`og.svg`, rasterized to `og.png`), the `og:title`, and the `Organization` / `SoftwareApplication` JSON-LD descriptions; the meta and OG description give the fuller external summary. <!-- @impl: landing/src/layouts/BaseLayout.astro::canonical --> <!-- @test: landing/src/__tests__/metadata.test.ts (REQ-LANDING-003: external metadata (SEO, social, structured data)) -->
5. The landing emits a JSON-LD `@graph` of schema.org structured data: a site-wide `Organization` (named, logo, `sameAs` the public repo) and `WebSite`, with the home page grafting on a `SoftwareApplication` entity, so search engines and LLMs resolve Codeflare to a named entity. <!-- @impl: landing/src/layouts/BaseLayout.astro::canonical --> <!-- @test: landing/src/__tests__/metadata.test.ts (REQ-LANDING-003: external metadata (SEO, social, structured data)) -->
6. The Worker serves discoverability documents at the deployment root, gated on the public landing being active (SaaS or onboarding): `robots.txt`, `sitemap.xml`, and `llms.txt`. In a private (default/enterprise) deployment `robots.txt` disallows all crawling and `sitemap.xml` / `llms.txt` return 404. <!-- @impl: src/lib/seo.ts::CANONICAL_ORIGIN --> <!-- @test: src/__tests__/lib/seo.test.ts (SEO discoverability documents (REQ-LANDING-003)) -->
7. The landing declares a `theme-color` and an `apple-touch-icon` for mobile share/install surfaces. <!-- @test: landing/src/__tests__/metadata.test.ts (REQ-LANDING-003 AC7: emits theme-color meta and an apple-touch-icon link) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- The OG/Twitter preview image is the brand asset at `web-ui/public/og.png` (1200x630), served from the SPA asset root at `/og.png`.
- JSON-LD is a `<script type="application/ld+json">` data block (not executed), so it is unaffected by the landing's `script-src 'self'` CSP.
- The discoverability documents are served before the setup-completion gate (so a crawler reaches them on a fresh instance) and use the hardcoded canonical origin (`https://codeflare.ch`), so an integration/staging host never advertises itself as canonical.
- [REQ-SETUP-010](setup.md#req-setup-010-social-share-preview-metadata-on-the-public-landing-page) continues to govern the SPA's own metadata (`web-ui/index.html`), which still serves `/app` and `/login`.

**Priority:** P2

**Dependencies:** [REQ-LANDING-001](#req-landing-001-mode-aware-public-landing-serving)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-LANDING-004: First-paint stability and immutable asset caching

**Intent:** Full-page navigations between the marketing landing and the SPA (Sign in → `/login`, and "Back to codeflare.ch") never flash the browser's default white canvas — nor the gray navigation canvas that Chromium forks (Vivaldi/Arc/Brave) expose while the next document has not yet painted, nor the intermittent light-gray flash the default view-transition cross-fade produced on these dark pages — and the landing's content-hashed build assets are cached immutably so its stylesheet is not revalidated on every navigation. This eliminates the inter-page flash (the white default, the fork gray canvas, and the cross-fade light-gray flash, in both light and dark appearance) and the delayed background/haze paint.

**Applies To:** User

**Acceptance Criteria:**

1. The landing layout declares the dark color scheme — a `<meta name="color-scheme" content="dark">` and an inline `html { color-scheme: dark; background-color: … }` rule emitted before any external stylesheet — so a cross-document navigation holds a dark canvas instead of flashing the browser's white default. <!-- @impl: landing/src/layouts/BaseLayout.astro::viewport --> <!-- @test: landing/src/__tests__/index-page.test.ts (REQ-LANDING-004: dark first paint (anti-flash contract)) -->
2. The Worker serves content-hashed `/_astro/` build assets with `Cache-Control: public, max-age=31536000, immutable`, while non-hashed asset responses keep their revalidating default so HTML stays fresh. <!-- @impl: src/index.ts::default --> <!-- @test: src/__tests__/index.test.ts (REQ-LANDING-004: immutable /_astro/ asset caching) -->
3. Every same-origin full-page navigation between the landing and `/login` opts into a cross-document view transition. <!-- @test: landing/src/__tests__/index-page.test.ts (REQ-LANDING-004: dark first paint (anti-flash contract)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- The SPA shell (`web-ui/index.html`) carries the same dark `color-scheme` meta and inline root paint, so navigating landing → `/login` (SPA) and back never flashes.
- The installable manifest's `theme_color` and `background_color` match the dark first-paint background so the PWA splash/install surface is consistent with the app's dark canvas.
- Immutability is keyed on the `/_astro/` path segment (Astro's content-hashed output directory): only those filenames change when content changes, so a stale cache entry is impossible; HTML and other non-hashed responses must keep revalidating so content stays fresh.
- Immutability is applied only to a real `200` asset whose response is not `text/html`, never the SPA fallback that `not_found_handling = "single-page-application"` returns for a non-existent `/_astro/` URL — caching that HTML shell forever-immutable under an asset URL would be a stale-shell trap.

**Priority:** P2

**Dependencies:** [REQ-LANDING-001](#req-landing-001-mode-aware-public-landing-serving)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-LANDING-005: Inference Mesh family hero

**Intent:** The public landing page presents Inference Mesh as the private inference layer of the Codeflare family directly under the primary hero, so a visitor sees, in one glance, that the agentic engine turns the idle machines a company already owns into private inference capacity for its agents, without leaving the page's existing proof-led narrative.

**Applies To:** User

**Acceptance Criteria:**

1. The landing renders a dedicated `#inference-mesh` hero band as a `<header>` directly after the primary hero and before the `#shift` section, reusing the existing section rhythm and tint and creating no second `h1`. <!-- @impl: landing/src/pages/index.astro::gate-crit --> <!-- @test: landing/src/__tests__/index-page.test.ts (inference mesh family hero (REQ-LANDING-005)) -->
2. The band headline is the product name `Inference Mesh` rendered as a plain white section-h2 (no flare, no scramble), right-aligned on desktop, and anchored by a `~/inference` path-tag chiplet (the shared `.kicker`) above it, also right-aligned; `Codeflare` is deliberately not repeated as a display wordmark here (the header logo and hero lead already establish it). <!-- @impl: landing/src/content/site.ts::INFERENCE_MESH --> <!-- @test: landing/src/__tests__/index-page.test.ts (inference mesh family hero (REQ-LANDING-005)) -->
3. The band description frames Inference Mesh as one optional additional inference source Codeflare can pull from — not its only or default inference path: Codeflare works with any provider, the mesh turns the idle machines you already own into private low-cost capacity for your agents, long-running sessions stay warm, sensitive work never leaves the boundary, and every hosted provider stays first-class as the default or the fallback. <!-- @impl: landing/src/content/site.ts::INFERENCE_MESH --> <!-- @test: landing/src/__tests__/index-page.test.ts (inference mesh family hero (REQ-LANDING-005)) -->
4. The band includes one external CTA labelled `See it on GitHub` linking to the public Inference Mesh repository, rendered as the shared `.micro-cta` text link (the same treatment as the dogfood CTA), with no secondary CTA and no dedicated detail route. <!-- @impl: landing/src/content/site.ts::INFERENCE_MESH --> <!-- @test: landing/src/__tests__/index-page.test.ts (inference mesh family hero (REQ-LANDING-005)) -->
5. The band uses the existing Terminal and Transcript proof system as a concrete inference-call artifact carrying the shared `proof-terminal` chrome, with its bottom command line driven by the shared typed reel (`data-ft-loop`) cycling the content-model beats, introducing no new animation system or terminal chrome. <!-- @impl: landing/src/content/site.ts::TERMINAL --> <!-- @test: landing/src/__tests__/index-page.test.ts (drives the shared typed reel on the terminal command line, looping over the beats) -->
6. The band is anchored as a right-aligned section mirroring the left proof terminal: a `~/inference` path-tag chiplet over the plain white `Inference Mesh` h2, both right-aligned on desktop (left on mobile), followed by the description and the micro-cta CTA; no product subtitle line and no repeated `Codeflare` display wordmark. <!-- @impl: landing/src/content/site.ts::INFERENCE_MESH --> <!-- @test: landing/src/__tests__/index-page.test.ts (inference mesh family hero (REQ-LANDING-005)) -->

**Constraints:**

- Product-led copy for this band may name the public model alias (`codeflare-mesh`), the served open model, throughput and economic figures, and capability outcomes such as cache-warm sessions, but never runtime, transport, provider-plumbing, or routing-internal components.
- Positioning invariant: the band must present Inference Mesh as an optional additional inference source, never as Codeflare's only or default inference path; hosted providers stay first-class (default or fallback). `Codeflare` is not repeated as a display wordmark in this band.
- The band has one CTA and no dedicated detail route.
- Structurally a second hero mirroring the primary hero: on desktop the proof terminal sits left and the copy right; on mobile and for assistive technology the copy is read before the proof.
- Client-side behavior is enhancement-only; the full band is readable without JavaScript.

**Priority:** P2

**Dependencies:** [REQ-LANDING-001](#req-landing-001-mode-aware-public-landing-serving)

**Verification:** [Landing render tests](../../landing/src/__tests__/index-page.test.ts), [Scramble behavior tests](../../landing/src/__tests__/scramble.script.test.ts)

**Status:** Implemented

---

### REQ-LANDING-006: Enter-the-Matrix sign-in CTA

**Intent:** The public landing header presents its sign-in call to action as an on-theme Matrix-flavoured flourish that pays off the page's existing Metacortex / Thomas Anderson easter egg, while remaining an unmistakable and accessible sign-in entry point.

**Applies To:** User

**Acceptance Criteria:**

1. The landing header renders a single sign-in CTA whose visible text is an on-theme decode label sourced from the typed content model, linking to the sign-in destination unchanged. <!-- @impl: landing/src/content/site.ts::NAV_LINKS --> <!-- @test: landing/src/__tests__/components.test.ts (renders one Enter-the-Matrix sign-in CTA: content-model label, aria-label, unchanged href, matrix modifier + hover-scramble hooks) -->
2. The CTA carries `aria-label="Sign in"` so its accessible name and purpose stay clear regardless of the visible flourish. <!-- @test: landing/src/__tests__/components.test.ts (header sign-in CTA (REQ-LANDING-006)) -->
3. The CTA text renders in the page primary white and carries the shared scramble hook in hover/focus decode mode, with a static readable fallback under reduced-motion and with no JavaScript. <!-- @impl: landing/src/components/Header.astro::brand --> <!-- @test: landing/src/__tests__/scramble.script.test.ts (REQ-LANDING-006: the hover-decode sign-in CTA locks each word span to its resting width so the header never reflows) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- The visible flourish never removes the accessible or semantic sign-in meaning (aria-label kept, href unchanged).
- Client-side scramble is enhancement-only; the button is fully readable and usable without JavaScript and under reduced-motion.
- No new color or font: the CTA colour is the existing `--text-primary` token; no new animation system (reuses `scramble.ts`).

**Priority:** P3

**Dependencies:** [REQ-LANDING-001](#req-landing-001-mode-aware-public-landing-serving)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-LANDING-007: Browser IDE continuity band

**Intent:** The public landing page presents the per-session Browser IDE as the bridge between the traditional SDLC and agentic development: a familiar VS Code window in the post-governance payoff cluster where a developer watches the agent work at machine speed and can take the wheel to edit directly, so the capability reads as continuity a traditional developer already trusts rather than a leap they must relearn.

**Applies To:** User

**Acceptance Criteria:**

1. The landing renders a dedicated `#ide` band directly after the `#platform` section, introducing no new frame. <!-- @impl: landing/src/pages/index.astro::agent-chips --> <!-- @test: landing/src/__tests__/index-page.test.ts (sits as a section directly after platform, built on the shared terminal frame) -->
2. The band renders as the full VS Code workbench (an activity rail, an explorer file tree, and the editor) built on the shared `<Terminal>` chrome. <!-- @impl: landing/src/components/CodeEditor.astro::ce-tab --> <!-- @test: landing/src/__tests__/code-editor.test.ts (renders the full workbench: activity rail with an active item and the source-control change badge) -->
3. The editor tab carries the file name and an unsaved-change dot. <!-- @test: landing/src/__tests__/code-editor.test.ts (renders the VS Code chrome on the shared terminal frame with the editor tab + modified dot) -->
4. The explorer renders the workspace file tree from the content model, one row per node, with the open file selected. <!-- @test: landing/src/__tests__/code-editor.test.ts (renders the explorer file tree with one row per model node and the open file selected) -->
5. The band shows a calm, line-numbered code pane whose gutter numbers come from a CSS counter, so no line numbers are hardcoded in the markup. <!-- @test: landing/src/__tests__/code-editor.test.ts (renders one line-numbered code row per source line) -->
6. The integrated terminal's command line is driven by the shared typed reel and nothing new: the `.code-editor` frame carries `data-ft-loop` (the content-model activity stream) plus `data-ft-shuffle`, and exactly one `[data-ft-typed]` line rests on the first beat. <!-- @impl: landing/src/components/CodeEditor.astro::ce-dot --> <!-- @test: landing/src/__tests__/code-editor.test.ts (wires the integrated terminal to the shared reel: data-ft-loop + data-ft-shuffle on the frame, resting log lines, one data-ft-typed line on the first beat) -->
7. The editor status bar carries the branch and caret-position segments from the content model and is the custom foot slot, not the default prose-caption foot. <!-- @impl: landing/src/components/CodeEditor.astro::ce-dot --> <!-- @test: landing/src/__tests__/code-editor.test.ts (renders the editor status bar with the branch and caret-position segments) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- The band reuses the shared `<Terminal>` chrome and the `feature-terminals.ts` reel; it introduces no new animation system or terminal frame.
- No new color: the band reads as VS Code through shape (the rail, the file tree, the tab, the line-number gutter, the integrated terminal, the status bar); active-state accents use only the page's one locked accent, never VS Code blue.
- The workbench fills the width on desktop; the activity rail and explorer fold away on narrow viewports, leaving the editor and integrated terminal full-width on mobile.
- Client-side behavior is enhancement-only; the server-rendered resting state is fully legible, including under prefers-reduced-motion.

**Priority:** P3

**Dependencies:** [REQ-LANDING-001](#req-landing-001-mode-aware-public-landing-serving)

**Verification:** Manual check

**Status:** Implemented
