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
5. Client enhancements animate terminal proofs, capability text, orchestration, reveals, and the page flare while preserving the complete server-rendered resting state and honoring reduced-motion preferences. <!-- @test: landing/src/__tests__/scramble.script.test.ts (scramble.ts (REQ-LANDING-001)) --> <!-- @manual -->
6. At mobile, tablet, and desktop widths, peer and subordinate sections remain visually distinct without overlap, clipping, or hidden content. <!-- @manual -->
7. Each navigation, trust, disclosure, contact, sign-in, and footer control reaches its intended destination by keyboard and remains visible without overlap or clipping at mobile, tablet, and desktop widths. <!-- @test: landing/src/__tests__/index-page.test.ts (grids, chips, nav, social proof, faq) --> <!-- @manual -->

**Constraints:**

- Authenticated visitors retain the app and subscription redirects; unauthenticated sign-in routes directly to the provider chooser.
- Landing assets build after the web UI, fall back to the legacy app when absent, and receive the root document's security headers.
- User-facing marketing copy stays platform-neutral except for relationship-neutral trust marks and functional third-party resources.
- Responsive, motion, typography, spacing, terminal, and enhancement mechanisms are documented in [architecture.md](../../documentation/lanes/architecture.md#landing-composition-implementation).

**Priority:** P1

**Dependencies:** None.

**Verification:** Automated test

**Status:** Implemented

---

### REQ-LANDING-009: Decorative flare failure fallback

**Intent:** The landing's decorative flare retires cleanly when a browser can no longer render it reliably, leaving the complete marketing surface readable on its stable CSS background.

**Applies To:** User

**Acceptance Criteria:**

1. Backgrounding on a coarse-pointer device retires the flare permanently. <!-- @impl: landing/src/scripts/splash.ts::initFlareFluid --> <!-- @test: landing/src/__tests__/splash.script.test.ts (retires the decorative canvas when a touch page is backgrounded) -->
2. Losing WebGL context retires the flare on any device and leaves the dark CSS page surface visible. <!-- @impl: landing/src/scripts/splash.ts::initFlareFluid --> <!-- @impl: landing/src/styles/global.css::html --> <!-- @test: landing/src/__tests__/splash.script.test.ts (falls back to the stable dark CSS background when the WebGL context is lost) -->

**Constraints:**

- The flare is decorative and does not request context restoration after retirement.

**Priority:** P2

**Dependencies:** [REQ-LANDING-001](#req-landing-001-mode-aware-public-landing-serving)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-LANDING-002: Demo-request contact pipeline

**Intent:** Enterprise prospects submit demo requests from the landing page through an abuse-protected endpoint that relays to the operators without storing personal data, keeping the landing's privacy promise ("not stored") literally true.

**Applies To:** User

**Acceptance Criteria:**

1. POST `/public/contact` validates name (1-100), email, company (optional, ≤200), topic (shared `CONTACT_TOPICS` enum), and message (10-4000); invalid input is rejected with 400. <!-- @impl: src/lib/contact-topics.ts::CONTACT_TOPICS --> <!-- @test: src/__tests__/routes/public-contact.test.ts (Public contact route (REQ-LANDING-002)) -->
2. The endpoint is available when SaaS mode or onboarding mode is active and returns 404 otherwise; the waitlist endpoint stays onboarding-only. <!-- @test: src/__tests__/routes/public-contact.test.ts (Public contact route (REQ-LANDING-002)) --> <!-- @manual -->
3. Submissions require a passing Turnstile verification; failures are rejected with a CAPTCHA validation error. <!-- @impl: src/routes/public/index.ts::requireVerifiedSubmission --> <!-- @test: src/__tests__/routes/public-contact.test.ts (Public contact route (REQ-LANDING-002)) -->
4. Accepted submissions are relayed as email to all admin users with reply-to set to the submitter, and every user-controlled field is HTML-escaped before rendering into the email body. <!-- @test: src/__tests__/routes/public-contact.test.ts (Public contact route (REQ-LANDING-002)) --> <!-- @manual -->
5. Submission content is never persisted — the only KV writes on the contact path are rate-limiter bookkeeping. <!-- @test: src/__tests__/routes/public-contact.test.ts (Public contact route (REQ-LANDING-002)) --> <!-- @manual -->
6. GET `/public/contact-config` exposes the Turnstile site key under the same mode gate, for the landing form widget. <!-- @impl: src/routes/public/index.ts::app --> <!-- @test: src/__tests__/routes/public-contact.test.ts (returns the Turnstile site key in SaaS mode) -->

**Constraints:**

- Rate-limited (5/minute per client) via the shared KV rate-limiter infrastructure ([REQ-SEC-007](security.md#req-sec-007-rate-limiting-infrastructure)).
- Topic values live in `src/lib/contact-topics.ts`, imported by both the Worker schema and the landing form — the form cannot offer a topic the API rejects.
- Returns 503 when Turnstile/Resend secrets or admin recipients are not configured (same degradation contract as the waitlist).

**Priority:** P1

**Dependencies:** [REQ-LANDING-001](#req-landing-001-mode-aware-public-landing-serving)

**Verification:** Automated test ([public-contact](../../src/__tests__/routes/public-contact.test.ts))

**Status:** Implemented

---

### REQ-LANDING-003: Landing social-share and search metadata

**Intent:** When codeflare.ch is shared or indexed, the unfurl and search snippet communicate the agentic-engineering-engine positioning with a branded preview card, structured data, and root discoverability documents, while private (default/enterprise) deployments stay out of the index.

**Applies To:** User

**Acceptance Criteria:**

1. The landing exposes the full Open Graph set: `og:type`, `og:site_name`, `og:title`, `og:description`, `og:url`, `og:image` (1200x630 with type/alt), `og:locale`. <!-- @impl: landing/src/layouts/BaseLayout.astro::og:description --> <!-- @test: landing/src/__tests__/metadata.test.ts (REQ-LANDING-003 AC1: emits the Open Graph meta tags with their contract values) -->
2. Twitter Card metadata is set with `summary_large_image` plus title, description, image, and image alt. <!-- @impl: landing/src/layouts/BaseLayout.astro::twitter:card --> <!-- @test: landing/src/__tests__/metadata.test.ts (REQ-LANDING-003 AC2: emits the Twitter Card meta tags) -->
3. The canonical URL is the served root (`https://codeflare.ch/`), not the `/landing/` asset path. <!-- @impl: landing/src/layouts/BaseLayout.astro::title --> <!-- @test: landing/src/__tests__/metadata.test.ts (REQ-LANDING-003 AC3: emits a canonical link with a non-empty href) -->
4. The social-share card and structured data carry the product's canonical positioning phrase, "agentic engineering engine": the OG image tagline (`og.svg`, rasterized to `og.png`), the `og:title`, and the `Organization` / `SoftwareApplication` JSON-LD descriptions; the meta and OG description give the fuller external summary. <!-- @impl: landing/src/layouts/BaseLayout.astro::canonical --> <!-- @test: landing/src/__tests__/metadata.test.ts (REQ-LANDING-003: external metadata (SEO, social, structured data)) -->
5. The landing emits a JSON-LD `@graph` of schema.org structured data: a site-wide `Organization` (named, logo, `sameAs` the public repo) and `WebSite`, with the home page grafting on a `SoftwareApplication` entity, so search engines and LLMs resolve Codeflare to a named entity. <!-- @impl: landing/src/layouts/BaseLayout.astro::canonical --> <!-- @test: landing/src/__tests__/metadata.test.ts (REQ-LANDING-003: external metadata (SEO, social, structured data)) -->
6. The Worker serves discoverability documents at the deployment root, gated on the public landing being active (SaaS or onboarding): `robots.txt`, `sitemap.xml`, and `llms.txt`. In a private (default/enterprise) deployment `robots.txt` disallows all crawling and `sitemap.xml` / `llms.txt` return 404. <!-- @impl: src/lib/seo.ts::CANONICAL_ORIGIN --> <!-- @test: src/__tests__/lib/seo.test.ts (SEO discoverability documents (REQ-LANDING-003)) -->
7. The landing declares a `theme-color` and an `apple-touch-icon` for mobile share/install surfaces. <!-- @test: landing/src/__tests__/metadata.test.ts (REQ-LANDING-003 AC7: emits theme-color meta and an apple-touch-icon link) --> <!-- @manual -->

**Constraints:**

- The OG/Twitter preview image is the brand asset at `web-ui/public/og.png` (1200x630), served from the SPA asset root at `/og.png`.
- JSON-LD is a `<script type="application/ld+json">` data block (not executed), so it is unaffected by the landing's `script-src 'self'` CSP.
- The discoverability documents are served before the setup-completion gate (so a crawler reaches them on a fresh instance) and use the hardcoded canonical origin (`https://codeflare.ch`), so an integration/staging host never advertises itself as canonical.
- [REQ-SETUP-010](setup.md#req-setup-010-social-share-preview-metadata-on-the-public-landing-page) continues to govern the SPA's own metadata (`web-ui/index.html`), which still serves `/app` and `/login`.

**Priority:** P2

**Dependencies:** [REQ-LANDING-001](#req-landing-001-mode-aware-public-landing-serving)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-LANDING-008: Login crawler exclusion controls

**Intent:** Public login pages stay out of search results while remaining crawlable long enough for search engines to observe their exclusion directive.

**Applies To:** Visitor

**Acceptance Criteria:**

1. The sitemap omits the public login route. <!-- @impl: src/lib/seo.ts::SITEMAP_PATHS --> <!-- @test: src/__tests__/lib/seo.test.ts (buildSitemapXml) -->
2. Every served login asset response carries `X-Robots-Tag: noindex, nofollow`. <!-- @impl: src/index.ts::fetch --> <!-- @test: src/__tests__/index.test.ts (REQ-LANDING-008: marks the public login response noindex without blocking the asset) -->
3. Public `robots.txt` leaves the login route crawlable so search crawlers can observe the exclusion directive. <!-- @impl: src/lib/seo.ts::buildRobotsTxt --> <!-- @test: src/__tests__/lib/seo.test.ts (advertises the marketing surface + sitemap while excluding private routes) -->

**Constraints:** None.

**Priority:** P2

**Dependencies:** [REQ-LANDING-003](#req-landing-003-landing-social-share-and-search-metadata)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-LANDING-004: First-paint stability and immutable asset caching

**Intent:** Full-page navigations between the marketing landing and the SPA (Sign in → `/login`, and "Back to codeflare.ch") never flash the browser's default white canvas — nor the gray navigation canvas that Chromium forks (Vivaldi/Arc/Brave) expose while the next document has not yet painted, nor the intermittent light-gray flash the default view-transition cross-fade produced on these dark pages — and the landing's content-hashed build assets are cached immutably so its stylesheet is not revalidated on every navigation. This eliminates the inter-page flash (the white default, the fork gray canvas, and the cross-fade light-gray flash, in both light and dark appearance) and the delayed background/haze paint.

**Applies To:** User

**Acceptance Criteria:**

1. The landing layout declares the dark color scheme — a `<meta name="color-scheme" content="dark">` and an inline `html { color-scheme: dark; background-color: … }` rule emitted before any external stylesheet — so a cross-document navigation holds a dark canvas. <!-- @impl: landing/src/layouts/BaseLayout.astro::viewport --> <!-- @test: landing/src/__tests__/index-page.test.ts (REQ-LANDING-004: dark first paint (anti-flash contract)) -->
2. Content-hashed landing assets remain reusable for one year without revalidation, while non-hashed assets continue to revalidate so HTML stays fresh. <!-- @impl: src/index.ts::default --> <!-- @test: src/__tests__/index.test.ts (REQ-LANDING-004: immutable /_astro/ asset caching) -->
3. Every same-origin full-page navigation between the landing and `/login` opts into a cross-document view transition. <!-- @test: landing/src/__tests__/index-page.test.ts (REQ-LANDING-004: dark first paint (anti-flash contract)) --> <!-- @manual -->

**Constraints:**

- The SPA shell (`web-ui/index.html`) carries the same dark `color-scheme` meta and inline root paint, so navigating landing → `/login` (SPA) and back never flashes.
- The installable manifest's `theme_color` and `background_color` match the dark first-paint background so the PWA splash/install surface is consistent with the app's dark canvas.
- Immutability is keyed on the `/_astro/` path segment (Astro's content-hashed output directory): only those filenames change when content changes, so a stale cache entry is impossible; HTML and other non-hashed responses must keep revalidating so content stays fresh.
- Immutability is applied only to a real `200` asset whose response is not `text/html`, never the SPA fallback served for a non-existent `/_astro/` URL.

**Priority:** P2

**Dependencies:** [REQ-LANDING-001](#req-landing-001-mode-aware-public-landing-serving)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-LANDING-005: Inference Mesh family hero

**Intent:** The public landing page presents Inference Mesh as the private inference layer of the Codeflare family directly under the primary hero, so a visitor sees, in one glance, that the agentic engine turns the idle machines a company already owns into private inference capacity for its agents, without leaving the page's existing proof-led narrative.

**Applies To:** User

**Acceptance Criteria:**

1. The landing presents Inference Mesh as a distinct family hero directly after the primary hero and before the Execution overview and detailed sections, reusing the existing section rhythm and tint while preserving one top-level page heading. <!-- @impl: landing/src/components/InferenceMeshHero.astro::INFERENCE_MESH --> <!-- @test: landing/src/__tests__/index-page.test.ts (inference mesh family hero (REQ-LANDING-005)) -->
2. `Inference Mesh` is a plain white, unscrambled section heading with a shared `~/inference` kicker; both align right on desktop, and Codeflare is not repeated. <!-- @impl: landing/src/content/site.ts::INFERENCE_MESH --> <!-- @test: landing/src/__tests__/index-page.test.ts (inference mesh family hero (REQ-LANDING-005)) -->
3. Copy presents Inference Mesh as optional private, low-cost capacity from owned idle machines with warm sessions and boundary-local sensitive work; any hosted provider remains a first-class default or fallback. <!-- @impl: landing/src/content/site.ts::INFERENCE_MESH --> <!-- @test: landing/src/__tests__/index-page.test.ts (inference mesh family hero (REQ-LANDING-005)) -->
4. The band includes one external CTA labelled `See it on GitHub` linking to the public Inference Mesh repository, rendered with the shared compact text-link treatment (the same treatment as the dogfood CTA), with no secondary CTA and no dedicated detail route. <!-- @impl: landing/src/content/site.ts::INFERENCE_MESH --> <!-- @test: landing/src/__tests__/index-page.test.ts (inference mesh family hero (REQ-LANDING-005)) -->
5. The band shows a concrete inference-call terminal whose bottom command cycles through the configured inference beats under normal motion. <!-- @impl: landing/src/content/site.ts::INFERENCE_MESH --> <!-- @test: landing/src/__tests__/index-page.test.ts (drives the shared typed reel on the terminal command line, looping over the beats) -->
6. Desktop places the right-aligned kicker, heading, description, and sole micro-CTA opposite the proof terminal; mobile left-aligns them. No subtitle or repeated Codeflare wordmark appears. <!-- @impl: landing/src/content/site.ts::INFERENCE_MESH --> <!-- @test: landing/src/__tests__/index-page.test.ts (inference mesh family hero (REQ-LANDING-005)) -->

**Constraints:**

- Product-led copy for this band may name the public model alias (`codeflare-mesh`), the served open model, throughput and economic figures, and capability outcomes such as cache-warm sessions, but never runtime, transport, provider-plumbing, or routing-internal components.
- Positioning invariant: the band must present Inference Mesh as an optional additional inference source, never as Codeflare's only or default inference path; hosted providers stay first-class (default or fallback); `Codeflare` is not repeated as a display wordmark in this band.
- The band has one CTA and no dedicated detail route.
- Structurally a second hero mirroring the primary hero: on desktop the proof terminal sits left and the copy right; on mobile and for assistive technology the copy is read before the proof.
- Client-side behavior is enhancement-only; the full band is readable without JavaScript.

**Priority:** P2

**Dependencies:** [REQ-LANDING-001](#req-landing-001-mode-aware-public-landing-serving)

**Verification:** Automated test ([Landing render tests](../../landing/src/__tests__/index-page.test.ts), [Scramble behavior tests](../../landing/src/__tests__/scramble.script.test.ts))

**Status:** Implemented

---

### REQ-LANDING-010: Execution overview reel

**Intent:** Immediately after the Hero family, the landing shows Codeflare as the place where software delivery and infrastructure operations play out in two truthful Hero-scale terminal simulations.

**Applies To:** Visitor

**Acceptance Criteria:**

1. Visitors encounter the primary Hero, then Inference Mesh, then the Execution overview before the detailed sections. <!-- @impl: landing/src/pages/index.astro::EXECUTION --> <!-- @test: landing/src/__tests__/index-page.test.ts (orders Hero -> Inference Mesh -> Execution -> detailed sections) -->
2. The dedicated Operations presentation remains present exactly once in its detailed role. <!-- @impl: landing/src/pages/index.astro::OPERATIONS --> <!-- @test: landing/src/__tests__/index-page.test.ts (retains the detailed Operations presentation exactly once) -->
3. The overview presents one software terminal and one infrastructure terminal side by side at the Hero terminal's half-width scale on desktop and tablet, stacking them only on mobile. <!-- @impl: landing/src/components/ExecutionReel.astro::execution-reel --> <!-- @impl: landing/src/components/ExecutionRun.astro::execution-face --> <!-- @impl: landing/src/styles/global.css::execution-card --> <!-- @test: landing/src/__tests__/index-page.test.ts (composes two shared Transcript simulations with full eight-row viewports) --> <!-- @manual -->
4. Each terminal preserves explicit engineer requests and approvals while agent progress continues autonomously only within approved gates. <!-- @impl: landing/src/content/site.ts::EXECUTION --> <!-- @test: landing/src/__tests__/index-page.test.ts (keeps every owner-approved row in both coherent execution timelines) -->
5. Both server-rendered terminals expose the complete semantic session and a full eight-row resolved viewport without JavaScript. <!-- @impl: landing/src/content/site.ts::EXECUTION --> <!-- @impl: landing/src/components/Transcript.astro::transcript-feed --> <!-- @test: landing/src/__tests__/index-page.test.ts (composes two shared Transcript simulations with full eight-row viewports) -->
6. The Execution and Operations presentations render without product-status preview badges. <!-- @impl: landing/src/components/ExecutionRun.astro::execution-face --> <!-- @impl: landing/src/pages/index.astro::OPERATIONS --> <!-- @test: landing/src/__tests__/index-page.test.ts (renders execution and operations without preview badges) -->

**Constraints:**

- Reuse the shared terminal visual and motion system.
- The software transcript shows `t.anderson@metacortex.ai` once in its opening request and follows production clone, planning, SDD/TDD execution, named review outcomes, real Inference Mesh PR #1, integration deployment and private-path verification, merge approval, squash merge, and `develop` realignment.
- The infrastructure transcript shows `t.anderson@metacortex.ai` once in its opening request and follows CMDB and parallel-SSH discovery for CVE-2024-6387, canary-first Ansible planning, human approval, autonomous gated fleet remediation, full-fleet rescan, and published incident evidence.
- Later engineer requests stay minimal; agent outcomes carry named evidence.
- No actor-label narration or invented product commands; diagnostic evidence uses cyan.
- Infrastructure copy exposes no private addresses, credentials, or roadmap details.
- Execution remains an overview; detailed sections retain their existing ownership.

**Priority:** P1

**Dependencies:** [REQ-LANDING-001](#req-landing-001-mode-aware-public-landing-serving), [REQ-LANDING-005](#req-landing-005-inference-mesh-family-hero)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-LANDING-011: Execution reel progressive motion

**Intent:** Under normal motion, each Execution terminal first fills from top to bottom with complete initial rows, then types the rest of its real session through the full viewport and settles with a blinking cursor.

**Applies To:** Visitor

**Acceptance Criteria:**

1. Each terminal starts independently once when that terminal enters the viewport and does not restart on later intersections. <!-- @impl: landing/src/scripts/proof.ts::startFeeds --> <!-- @impl: landing/src/scripts/proof.ts::startFeed --> <!-- @test: landing/src/__tests__/execution-reel.script.test.ts (completes both authored simulations independently and never restarts them) -->
2. Before live activity starts, each terminal reveals its populated opening viewport from top to bottom: complete context on desktop and the largest fully fitting prefix in a synchronized mobile/tablet frame. <!-- @impl: landing/src/scripts/proof.ts::prepareFeed --> <!-- @impl: landing/src/styles/global.css::term-type --> <!-- @test: landing/src/__tests__/execution-reel.script.test.ts (prepares populated opening rows and retains complete context histories) --> <!-- @test: landing/src/__tests__/execution-reel.script.test.ts (matches the Hero frame and queues fractionally clipped context without visible resets) -->
3. After the initial entrance finishes, the newest row remains bottom-aligned within the unchanged clipped frame as each remaining event stages or appends and types and as the viewport resizes. <!-- @impl: landing/src/scripts/proof.ts::startFeed --> <!-- @impl: landing/src/scripts/proof.ts::scrollFeedToEnd --> <!-- @test: landing/src/__tests__/execution-reel.script.test.ts (types the simulation to completion in a fixed scrolling log with final cursor) -->
4. Throughout the hold before the first queued line types, one continuously blinking caret sits on that line's empty staged row at its exact text-start column—after the prompt for a command—and the same row becomes the first typing row. <!-- @impl: landing/src/scripts/proof.ts::pendingFeedRow --> <!-- @impl: landing/src/scripts/proof.ts::startFeed --> <!-- @impl: landing/src/styles/global.css::t-caret --> <!-- @test: landing/src/__tests__/execution-reel.script.test.ts (types the simulation to completion in a fixed scrolling log with final cursor) -->
5. Both simulations settle after their authored final event with a continuously blinking cursor on the last row. <!-- @impl: landing/src/scripts/proof.ts::settleFeed --> <!-- @impl: landing/src/styles/global.css::t-caret --> <!-- @test: landing/src/__tests__/execution-reel.script.test.ts (types the simulation to completion in a fixed scrolling log with final cursor) --> <!-- @test: landing/src/__tests__/execution-reel.script.test.ts (completes both authored simulations independently and never restarts them) -->
6. When intersection observation is unavailable, both full resolved event viewports remain static. <!-- @impl: landing/src/scripts/proof.ts::startWithoutIntersectionObserver --> <!-- @test: landing/src/__tests__/execution-reel.script.test.ts (leaves resolved feed viewports static when intersection observation is unavailable) -->
7. While a command event types, the shared prompt remains directly beside the live text without occupying an extra row. <!-- @impl: landing/src/scripts/proof.ts::typeFeedRow --> <!-- @impl: landing/src/styles/global.css::is-feed-typing --> <!-- @test: landing/src/__tests__/execution-reel.script.test.ts (types the simulation to completion in a fixed scrolling log with final cursor) -->

**Constraints:**

- Reuse the landing's shared Transcript feed, proof observer, `term-type` entrance, 420 ms scroll phase, 58 ms typing cadence, and permanent terminal chrome.
- Initial rows complete their ordered entrance before `is-rolling` disables entrance keyframes for appended live rows.
- Completed rows remain in the log and overflow upward only when newer work needs the fixed viewport.

**Priority:** P1

**Dependencies:** [REQ-LANDING-010](#req-landing-010-execution-overview-reel)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-LANDING-012: Execution reel reduced-motion accessibility

**Intent:** Visitors who request reduced motion receive the complete Execution overview without animated presentation.

**Applies To:** Visitor

**Acceptance Criteria:**

1. The reel presents no animation under reduced motion. <!-- @impl: landing/src/scripts/proof.ts::reduced --> <!-- @impl: landing/src/components/Transcript.astro::transcript-feed --> <!-- @test: landing/src/__tests__/execution-reel.script.test.ts (keeps intrinsic complete resolved event viewports under reduced motion) --> <!-- @manual -->
2. Under reduced motion, both populated resolved event viewports remain visible and readable. <!-- @impl: landing/src/components/Transcript.astro::transcript-feed --> <!-- @test: landing/src/__tests__/execution-reel.script.test.ts (keeps intrinsic complete resolved event viewports under reduced motion) --> <!-- @manual -->

**Constraints:**

- Screen readers consume the complete semantic sessions rather than character-by-character visual updates.
- Reduced-motion visitors retain both complete Hero-scale terminal viewports.

**Priority:** P1

**Dependencies:** [REQ-LANDING-010](#req-landing-010-execution-overview-reel), [REQ-LANDING-011](#req-landing-011-execution-reel-progressive-motion)

**Verification:** Manual check

**Status:** Partial

---

### REQ-LANDING-013: Canonical README media capture

**Intent:** Deployed landing components remain the sole product source for deterministic README animations.

**Applies To:** Maintainer

**Acceptance Criteria:**

1. The resolved Execution reel is self-contained at a wide aspect suitable for README capture. <!-- @impl: landing/src/components/ExecutionReel.astro::data-readme-reel --> <!-- @manual -->
2. The six animations derive from the deployed Execution, Browser VS Code, Browser E2E, review, deployment, and Inference Mesh components and approved content. <!-- @manual -->
3. Each GIF contains at least three decodable frames. <!-- @impl: scripts/ci/readme-media-contract.mjs::README_MEDIA --> <!-- @test: host/__tests__/readme-media.test.js (README canonical landing media) -->
4. Execution, Browser E2E, and deployment play exactly once. <!-- @impl: scripts/ci/readme-media-contract.mjs::README_MEDIA --> <!-- @test: host/__tests__/readme-media.test.js (README canonical landing media) -->
5. Execution, Browser E2E, and deployment end on their resolved static frame. <!-- @manual -->
6. Browser VS Code, review, and Inference Mesh repeat indefinitely. <!-- @impl: scripts/ci/readme-media-contract.mjs::README_MEDIA --> <!-- @test: host/__tests__/readme-media.test.js (README canonical landing media) -->

**Constraints:** Media capture starts only after its landing source is reviewed, CI-green, deployed, and visually approved; it adds no capture-only product route.

**Priority:** P1

**Dependencies:** [REQ-LANDING-010](#req-landing-010-execution-overview-reel), [REQ-LANDING-011](#req-landing-011-execution-reel-progressive-motion)

**Verification:** Automated frame and loop decoding; source provenance and resolved one-shot frames accepted in the [2026-07-31 media record](../../documentation/lanes/readme-media-acceptance.md)

**Status:** Implemented

---

### REQ-LANDING-016: README media accessibility and composition

**Intent:** Repository media remains readable and motion-safe.

**Applies To:** Visitor

**Acceptance Criteria:**

1. Every GIF has a decodable PNG fallback. <!-- @impl: scripts/ci/readme-media-contract.mjs::README_MEDIA --> <!-- @test: host/__tests__/readme-media.test.js (README canonical landing media) -->
2. Each PNG fallback has exactly the dimensions of its GIF. <!-- @impl: scripts/ci/readme-media-contract.mjs::README_MEDIA --> <!-- @test: host/__tests__/readme-media.test.js (README canonical landing media) -->
3. Each top-level README picture block declares its PNG source for `prefers-reduced-motion: reduce`. <!-- @impl: README.md::readme-media-browser-e2e --> <!-- @test: host/__tests__/readme-media.test.js (README canonical landing media) -->
4. Each picture has alt text that describes the depicted product behavior. <!-- @impl: README.md::readme-media-review-governance --> <!-- @manual -->
5. Each animated image declares a 1,200-pixel README presentation width. <!-- @impl: README.md::readme-media-browser-vscode --> <!-- @test: host/__tests__/readme-media.test.js (README canonical landing media) -->

**Constraints:** The six GIF/PNG pairs are repository-hosted and share their deployed landing composition.

**Priority:** P1

**Dependencies:** [REQ-LANDING-013](#req-landing-013-canonical-readme-media-capture)

**Verification:** Automated picture, decoding, dimension, and width checks; image-specific alt text accepted in the [2026-07-31 media record](../../documentation/lanes/readme-media-acceptance.md)

**Status:** Implemented

---

### REQ-LANDING-017: README media repository budgets

**Intent:** Canonical README media remains bounded in the repository.

**Applies To:** Maintainer

**Acceptance Criteria:**

1. Each GIF is at most 10 MiB. <!-- @impl: scripts/ci/readme-media-contract.mjs::README_MEDIA_BUDGETS --> <!-- @test: host/__tests__/readme-media.test.js (README canonical landing media) -->
2. The twelve GIF/PNG assets total at most 30 MiB. <!-- @impl: scripts/ci/readme-media-contract.mjs::README_MEDIA_BUDGETS --> <!-- @test: host/__tests__/readme-media.test.js (README canonical landing media) -->

**Constraints:** Budgets cover the six committed GIF/PNG pairs.

**Priority:** P1

**Dependencies:** [REQ-LANDING-013](#req-landing-013-canonical-readme-media-capture), [REQ-LANDING-016](#req-landing-016-readme-media-accessibility-and-composition)

**Verification:** Automated repository budget checks

**Status:** Implemented

---

### REQ-LANDING-018: README media retirement

**Intent:** Canonical media replaces superseded product pictures without removing the Architecture explanation.

**Applies To:** Maintainer

**Acceptance Criteria:**

1. The foldable, phone, IDE, and setup picture names are absent from uncommented, unfenced README content. <!-- @impl: scripts/ci/readme-media-contract.mjs::RETIRED_README_PICTURES --> <!-- @test: host/__tests__/readme-media.test.js (README canonical landing media) -->
2. The foldable, phone, IDE, and setup picture files are absent from repository media. <!-- @impl: scripts/ci/readme-media-contract.mjs::RETIRED_README_PICTURES --> <!-- @test: host/__tests__/readme-media.test.js (README canonical landing media) -->
3. The Architecture section retains its Mermaid topology instead of a duplicate product screenshot. <!-- @impl: README.md::mermaid --> <!-- @manual -->

**Constraints:** Retirement removes only the four superseded files and references.

**Priority:** P1

**Dependencies:** [REQ-LANDING-016](#req-landing-016-readme-media-accessibility-and-composition)

**Verification:** Automated README and repository retirement checks; retained Mermaid Architecture accepted in the [2026-07-31 media record](../../documentation/lanes/readme-media-acceptance.md)

**Status:** Implemented

---

### REQ-LANDING-019: README media GitHub acceptance

**Intent:** Canonical README media renders correctly for GitHub visitors.

**Applies To:** Visitor

**Acceptance Criteria:**

1. GitHub renders all six picture blocks legibly at repository content width. <!-- @manual -->
2. Each GIF path resolves on GitHub. <!-- @manual -->
3. Each resolved GIF plays on GitHub. <!-- @manual -->
4. GitHub playback does not clip any animation frame. <!-- @manual -->
5. Each PNG path resolves when reduced motion is requested. <!-- @manual -->
6. GitHub does not clip any static fallback. <!-- @manual -->

**Constraints:** Publishing acceptance uses the committed assets rather than an alternate capture or rendering path.

**Priority:** P1

**Dependencies:** [REQ-LANDING-016](#req-landing-016-readme-media-accessibility-and-composition), [REQ-LANDING-017](#req-landing-017-readme-media-repository-budgets), [REQ-LANDING-018](#req-landing-018-readme-media-retirement)

**Verification:** Manual GitHub rendering check

**Status:** Partial

---

### REQ-LANDING-014: Execution reel responsive layout stability

**Intent:** The Execution reel remains contained and does not disturb surrounding content across supported viewport sizes.

**Applies To:** Visitor

**Acceptance Criteria:**

1. The side-by-side Hero-scale terminals remain readable and contained without horizontal page overflow at tablet and desktop widths, then stack cleanly on mobile. <!-- @impl: landing/src/styles/global.css::execution-reel --> <!-- @impl: landing/src/styles/global.css::execution-card --> <!-- @impl: landing/src/styles/global.css::execution-terminal --> <!-- @manual -->
2. With normal-motion JavaScript enhancement at mobile and tablet widths, the rendered Hero and both Execution terminals retain equal outer heights through their typing animations and responsive viewport-width changes. <!-- @impl: landing/src/scripts/feature-terminals.ts::reserveHeroFrame --> <!-- @impl: landing/src/scripts/proof.ts::syncExecutionFrames --> <!-- @impl: landing/src/styles/global.css::execution-terminal --> <!-- @test: landing/src/__tests__/feature-terminals.script.test.ts (REQ-LANDING-014: reserves the Hero frame at its tallest command across typing) --> <!-- @test: landing/src/__tests__/feature-terminals.script.test.ts (REQ-LANDING-014: keeps shuffled non-Hero terminals intrinsically sized) --> <!-- @test: landing/src/__tests__/execution-reel.script.test.ts (matches the Hero frame and queues fractionally clipped context without visible resets) --> <!-- @manual -->
3. Each independently progressing transcript retains prior rows in a clipped scrolling log with the same contiguous line rhythm as the other landing-page terminals, never distributing spare body height between rows. <!-- @impl: landing/src/scripts/proof.ts::scrollFeedToEnd --> <!-- @impl: landing/src/styles/global.css::execution-terminal .transcript-feed --> <!-- @test: landing/src/__tests__/execution-reel.script.test.ts (types the simulation to completion in a fixed scrolling log with final cursor) --> <!-- @manual -->
4. Each appended event scrolls the newest work into view, and the completed active row—including a command prompt when applicable—reserves its wrapped height throughout typing without shifting the terminal or page. <!-- @impl: landing/src/scripts/proof.ts::typeFeedRow --> <!-- @impl: landing/src/styles/global.css::is-feed-typing --> <!-- @test: landing/src/__tests__/execution-reel.script.test.ts (keeps wrapped row geometry reserved inside the fixed scrolling viewport) --> <!-- @manual -->
5. At mobile and tablet widths, normal motion reveals the largest approved context prefix that fits fully inside the synchronized frame together with one empty staged row for the first queued line. <!-- @impl: landing/src/scripts/proof.ts::prepareFeed --> <!-- @impl: landing/src/scripts/proof.ts::pendingFeedRow --> <!-- @test: landing/src/__tests__/execution-reel.script.test.ts (matches the Hero frame and queues fractionally clipped context without visible resets) --> <!-- @manual -->
6. Every context row outside that opening prefix types in original order before the authored events, so the first append never skips hidden pre-event history. <!-- @impl: landing/src/scripts/proof.ts::startFeed --> <!-- @test: landing/src/__tests__/execution-reel.script.test.ts (matches the Hero frame and queues fractionally clipped context without visible resets) --> <!-- @manual -->
7. All 40 owner-approved reel rows remain exact, including continuation evidence. <!-- @impl: landing/src/content/site.ts::EXECUTION --> <!-- @test: landing/src/__tests__/index-page.test.ts (keeps every owner-approved row in both coherent execution timelines) --> <!-- @manual -->

**Constraints:**

- Responsive behavior reuses the landing's existing breakpoints and spacing tokens.
- No-JavaScript and reduced-motion rendering keeps intrinsic frame sizing and the complete resolved viewport.
- The terminal body clips overflow and is not user-scrollable; only the scripted feed progression changes the log position. <!-- @impl: landing/src/styles/global.css::execution-terminal .terminal-body --> <!-- @impl: landing/src/scripts/proof.ts::scrollFeedToEnd --> <!-- @test: landing/src/__tests__/index-page.test.ts (sizes fixed scrolling logs from resolved then initial states without row gaps) --> <!-- @test: landing/src/__tests__/execution-reel.script.test.ts (types the simulation to completion in a fixed scrolling log with final cursor) -->

**Priority:** P1

**Dependencies:** [REQ-LANDING-010](#req-landing-010-execution-overview-reel), [REQ-LANDING-011](#req-landing-011-execution-reel-progressive-motion)

**Verification:** Manual check

**Status:** Partial

---

### REQ-LANDING-015: Execution reel merged-PR link

**Intent:** The software Execution transcript exposes its real merged Inference Mesh pull request as a safe, accessible terminal link.

**Applies To:** Visitor

**Acceptance Criteria:**

1. Only the exact approved PR #1 URL, appearing once as the final standalone line of its row, becomes interactive. <!-- @impl: landing/src/lib/execution-link.ts::approvedExecutionLinkStart --> <!-- @impl: landing/src/components/Transcript.astro::transcript-feed --> <!-- @impl: landing/src/scripts/proof.ts::parseFeed --> <!-- @test: landing/src/__tests__/components.test.ts (accepts exactly one approved PR URL as the final standalone transcript line) --> <!-- @test: landing/src/__tests__/execution-reel.script.test.ts (rejects a feed link other than the exact approved pull request) -->
2. The approved URL opens externally by pointer or keyboard, and keyboard focus remains visible inside the terminal. <!-- @impl: landing/src/components/Transcript.astro::transcript-feed --> <!-- @impl: landing/src/scripts/proof.ts::renderFeedRowText --> <!-- @impl: landing/src/styles/global.css::transcript-feed-semantic --> <!-- @test: landing/src/__tests__/components.test.ts (animate='feed' sizes from the first eight context rows while retaining complete semantic content) --> <!-- @test: landing/src/__tests__/index-page.test.ts (renders the real merged PR as a terminal-styled external link) -->
3. The link inherits terminal color and removes conventional link decoration. <!-- @impl: landing/src/styles/global.css::terminal-inline-link --> <!-- @test: landing/src/__tests__/index-page.test.ts (renders the real merged PR as a terminal-styled external link) -->

**Constraints:**

- The visual animation copy stays out of the keyboard tab order; the complete semantic transcript owns keyboard activation.
- Parsed transcript data never supplies a URL to an HTML or DOM link sink.

**Priority:** P1

**Dependencies:** [REQ-LANDING-010](#req-landing-010-execution-overview-reel)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-LANDING-006: Enter-the-Matrix sign-in CTA

**Intent:** The public landing header presents its sign-in call to action as an on-theme Matrix-flavoured flourish that pays off the page's existing Metacortex / Thomas Anderson easter egg, while remaining an unmistakable and accessible sign-in entry point.

**Applies To:** User

**Acceptance Criteria:**

1. The landing header renders a single sign-in CTA whose visible text is an on-theme decode label sourced from the typed content model, linking to the sign-in destination unchanged. <!-- @impl: landing/src/content/site.ts::HEADER_SIGN_IN --> <!-- @test: landing/src/__tests__/components.test.ts (renders one Enter-the-Matrix sign-in CTA: content-model label, aria-label, unchanged href, matrix modifier + hover-scramble hooks) -->
2. The CTA carries `aria-label="Sign in"` so its accessible name and purpose stay clear regardless of the visible flourish. <!-- @test: landing/src/__tests__/components.test.ts (header sign-in CTA (REQ-LANDING-006)) --> <!-- @manual -->
3. The CTA uses the page's primary white and the shared hover/focus scramble hook. <!-- @impl: landing/src/components/Header.astro::nav-signin--matrix --> <!-- @impl: landing/src/styles/global.css::nav-signin--matrix --> <!-- @test: landing/src/__tests__/components.test.ts (header sign-in CTA (REQ-LANDING-006)) --> <!-- @manual -->
4. Without JavaScript or under reduced motion, the visible sign-in label remains static and readable. <!-- @impl: landing/src/components/Header.astro::nav-signin--matrix --> <!-- @impl: landing/src/scripts/scramble.ts::setupHoverElement --> <!-- @test: landing/src/__tests__/components.test.ts (header sign-in CTA (REQ-LANDING-006)) --> <!-- @test: landing/src/__tests__/scramble.script.test.ts (REQ-LANDING-001: under prefers-reduced-motion the element text is NOT mutated) -->
5. During the hover decode the visible button chrome — an out-of-flow shell shrink-wrapping the churning glyphs — grows and shrinks with the churn frame, centered so growth spills symmetrically, while the CTA's in-flow layout box keeps its resting size. <!-- @impl: landing/src/scripts/scramble.ts::setupHoverElement --> <!-- @impl: landing/src/styles/global.css::scramble-shell --> <!-- @test: landing/src/__tests__/scramble.script.test.ts (REQ-LANDING-006: the hover-decode CTA hands its chrome to an out-of-flow shell that shrink-wraps the churn while an in-flow ghost holds the layout box) -->
6. The CTA animation leaves every navigation-link rectangle fixed. <!-- @impl: landing/src/styles/global.css::scramble-shell --> <!-- @test: landing/src/__tests__/scramble.script.test.ts (REQ-LANDING-006: the hover-decode CTA hands its chrome to an out-of-flow shell that shrink-wraps the churn while an in-flow ghost holds the layout box) -->

**Constraints:**

- The visible flourish never removes the accessible or semantic sign-in meaning (aria-label kept, href unchanged).
- Client-side scramble is enhancement-only; the button is fully readable and usable without JavaScript and under reduced-motion.
- The CTA is content-sized at every breakpoint — no reserved slot or width lock; sibling stability comes from the fixed in-flow anchor box, with the growing chrome on an out-of-flow shell.
- No new color or font: the CTA colour is the existing `--text-primary` token; no new animation system (reuses `scramble.ts`).

**Priority:** P3

**Dependencies:** [REQ-LANDING-001](#req-landing-001-mode-aware-public-landing-serving)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-LANDING-007: Browser IDE continuity band

**Intent:** The public landing page presents the per-session Browser IDE as the bridge between the traditional SDLC and agentic development: a familiar VS Code window in the post-governance payoff cluster where a developer watches the agent work at machine speed and can take the wheel to edit directly, so the capability reads as continuity a traditional developer already trusts rather than a leap they must relearn.

**Applies To:** User

**Acceptance Criteria:**

1. The landing renders a dedicated `#ide` band directly after the `#platform` section, introducing no new frame. <!-- @impl: landing/src/pages/index.astro::agent-chips --> <!-- @test: landing/src/__tests__/index-page.test.ts (sits as a section directly after platform, built on the shared terminal frame) -->
2. The band renders as the full VS Code workbench (an activity rail, an explorer file tree, and the editor) built on the shared `<Terminal>` chrome. <!-- @impl: landing/src/components/CodeEditor.astro::ce-tab --> <!-- @test: landing/src/__tests__/code-editor.test.ts (renders the full workbench: activity rail with an active item and the source-control change badge) -->
3. The editor tab carries the file name and an unsaved-change dot. <!-- @test: landing/src/__tests__/code-editor.test.ts (renders the VS Code chrome on the shared terminal frame with the editor tab + modified dot) --> <!-- @manual -->
4. The explorer renders the workspace file tree from the content model, one row per node, with the open file selected. <!-- @test: landing/src/__tests__/code-editor.test.ts (renders the explorer file tree with one row per model node and the open file selected) --> <!-- @manual -->
5. The band shows a calm, line-numbered code pane whose gutter numbers come from a CSS counter, so no line numbers are hardcoded in the markup. <!-- @test: landing/src/__tests__/code-editor.test.ts (renders one line-numbered code row per source line) --> <!-- @manual -->
6. The integrated terminal's command line is driven by the shared typed reel and nothing new: the `.code-editor` frame carries `data-ft-loop` (the content-model activity stream) plus `data-ft-shuffle`, and exactly one `[data-ft-typed]` line rests on the first beat. <!-- @impl: landing/src/components/CodeEditor.astro::ftLoop --> <!-- @test: landing/src/__tests__/code-editor.test.ts (wires the integrated terminal to the shared reel: data-ft-loop + data-ft-shuffle on the frame, resting log lines, one data-ft-typed line on the first beat) -->
7. The editor status bar carries the branch and caret-position segments from the content model and is the custom foot slot, not the default prose-caption foot. <!-- @impl: landing/src/components/CodeEditor.astro::ce-status --> <!-- @test: landing/src/__tests__/code-editor.test.ts (renders the editor status bar with the branch and caret-position segments) -->

**Constraints:**

- The band reuses the shared `<Terminal>` chrome and the `feature-terminals.ts` reel; it introduces no new animation system or terminal frame.
- No new color: the band reads as VS Code through shape (the rail, the file tree, the tab, the line-number gutter, the integrated terminal, the status bar); active-state accents use only the page's one locked accent, never VS Code blue.
- The workbench fills the width on desktop; the activity rail and explorer fold away on narrow viewports, leaving the editor and integrated terminal full-width on mobile.
- Client-side behavior is enhancement-only; the server-rendered resting state is fully legible, including under prefers-reduced-motion.

**Priority:** P3

**Dependencies:** [REQ-LANDING-001](#req-landing-001-mode-aware-public-landing-serving)

**Verification:** Automated test

**Status:** Implemented

---
