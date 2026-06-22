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

**Intent:** Unauthenticated visitors to the deployment root in SaaS or onboarding mode see the enterprise marketing landing page — positioning Codeflare as the enterprise agentic engine — while authenticated users and default-mode deployments keep their existing app entry flow.

**Applies To:** User

**Acceptance Criteria:**

1. An unauthenticated GET `/` in SaaS mode is served the prerendered landing app (the asset request is rewritten to `/landing/`). <!-- @impl: src/index.ts::default --> <!-- @test: src/__tests__/index.test.ts (serves the static landing at / in SaaS mode, unauthenticated) -->
2. An unauthenticated GET `/` in onboarding mode is served the same landing app. <!-- @impl: src/index.ts::default --> <!-- @test: src/__tests__/index.test.ts (serves the static landing at / when onboarding mode is active) -->
3. In default mode, GET `/` redirects to `/app/` and the landing is never served. <!-- @impl: src/index.ts::default --> <!-- @test: src/__tests__/index.test.ts (keeps redirecting / to /app in default mode, no landing) -->
4. The landing renders the full enterprise narrative statically (no JS required): a hero whose top line turns `THE ENTERPRISE AGENTIC [WORD] ENGINE` into a data-driven vertical capability-word stack (static words coral, active word white, queued words ghosted upward, and the `ENGINE` suffix tracking the active word width) before the big headline states what Codeflare is not and answers it immediately beneath with a plain one-sentence definition line, rendered in the terminal command white (Codeflare runs governed engineering agents inside your own estate, where each change is backed by a spec, proven by tests, documented, and handed to your team to approve, whether that is a pull request to merge or a change to run, with an enforcement loop that keeps spec, tests, and code in lockstep so drift is impossible), beside a single legible terminal demo whose transcript follows one governed run (a spec drift flagged as a blocking finding, an isolated-browser markdown ingestion, a denied direct-provider egress redirected to the AI Gateway, the "spec, code, docs aligned" refrain) carrying an agent statusline foot (context, model, reasoning level), a spine strip naming that run, and a capability reel on its bottom command line (one highlight per beat) that loops continuously and is shuffled on each load (the shared feature-terminal typing engine, `data-ft-loop` + `data-ft-shuffle`; the authored `run[0]` is the no-JS resting state); a feature-terminal grid in the shift section (four compact terminals, each showing one codeflare capability as a real command and its output with a one-line caption foot, replacing the former stat band and checkmark comparison); a spec-driven-development "method" section presenting SDD/TDD enforcement as a self-healing enforcement gate, with its two pillars as plain label-and-prose clauses (no numbered counter); a legacy-rescue section (`/sdd init` reverse-engineering a legacy codebase into a spec-driven baseline and `/sdd clean` realigning a drifted spec, shown as a full-width narrative terminal under a standard section head) placed between method and security; a security section whose unified boundary gate (approved and impossible paths as pass/deny rows sharing the same gate grammar as the enforcement gate) and the one egress call inspected below it (shown as a left-aligned command echo above a thin in-terminal divider, the egress rows animating like the boundary rows above) make zero-trust, DLP, and guardrails auditable (the boundary receipt also carrying a post-quantum transport row: sessions keyed with X25519MLKEM768 hybrid key agreement), the boundary and the egress rows folded into one terminal closing on a single in-chrome foot; a browser-isolation context section rendering the open-web-to-markdown fetch and the agent-steered e2e (the same throwaway browser driving a deployed flow from a mobile viewport and returning a pass/fail verdict) as full-width terminals under a standard section head, the e2e introduced by a subordinate `.substation` sub-head so it reads as part of the section; a parallel review board; a live, dynamic agent-orchestration section of its own ("Running N agents" with per-agent tool-use and token counters that tick as they work via `orch.ts`, ordinary agent commands rather than internal tool names, and the `ctrl+o` / `ctrl+b` affordances); a cost attribution ledger; a platform "arrives equipped" section whose seeded capabilities render as a session-boot proof terminal (a rolling loaded-checklist in the same gate grammar, `data-roll`, `PLATFORM.seed`) rather than prose feature cards; an MCP tool-governance section rendering the portal as a dynamic proof terminal in the same gate grammar (many MCP servers collapsed to one endpoint, every call made as the signed-in user with least privilege and attributed, and code mode collapsing the whole tool surface into a single typed `code` tool run in an isolated worker, shown as the cyan `code mode` governance row); sections that read as calm peers in document order (shift, method, legacy, security, context, pipeline, orchestration, cost, platform, mcp, dogfood, faq, contact), each opening the same way (a terminal-path tag rendered as `~/<name>`, then the h2 and lead, at full width) so a reader feels where every section starts, cued by that per-section tag and the alternating section backgrounds rather than a numbered spine (the five nav-pillar sections reuse their pillar word as the tag), with the secondary bands (operations, tenancy, runs-everywhere, trusted) folded into their parent section as subordinate `.substation` sub-content (a nested terminal-path tag like `~/security/operations` above an `--fs-subhead` sub-head) so nothing floats; all content sections with anchor ids matching the nav links; a dogfood proof section (this page as REQ-LANDING-001, with its real @impl/@test anchors rendered as a terminal widget closing on an in-chrome foot, and the page's only GitHub link as its CTA) with a relationship-neutral trust-logo strip folded in as its tail (four wordmark-free brand marks normalized to one shared bounding box so marks of differing aspect ratio carry equal visual weight, rendered in a calm desaturated tone at rest and restoring colour on hover, ordered alphabetically under an "In good company" eyebrow, each linking to its site); an FAQ rendered as two columns on desktop via CSS multi-column flow (so an expanded question grows within its own column without displacing a neighbour), each item animating open and closed via a `::details-content` block-size transition unless the visitor prefers reduced motion (then it snaps), placed after the proof so the dogfood lands before the closing answers; the contact form (two columns at the same 820px breakpoint as the hero and split sections, intro copy left and form right, stacking on narrower viewports); and a Sign in action (nav) linking to the login provider-chooser (`/login`, `APP_LINKS.signIn`); the footer is reduced to one quiet centered "Built with Codeflare" line (no Sign in, GitHub mark, or nav links). The governance sections carry the page; the platform-capability sections follow as the payoff the boundary makes safe. <!-- @impl: landing/src/pages/index.astro --> <!-- @impl: landing/src/components/Section.astro --> <!-- @impl: landing/src/components/SectionHead.astro --> <!-- @impl: landing/src/components/Terminal.astro --> <!-- @impl: landing/src/components/Transcript.astro --> <!-- @impl: landing/src/components/FeatureTerminals.astro --> <!-- @impl: landing/src/components/HeroKicker.astro --> <!-- @impl: landing/src/components/GateSteps.astro --> <!-- @impl: landing/src/components/ReviewBoard.astro --> <!-- @impl: landing/src/components/LedgerTable.astro --> <!-- @impl: landing/src/components/OrchTree.astro --> <!-- @impl: landing/src/components/FeatureGrid.astro --> <!-- @impl: landing/src/components/Header.astro --> <!-- @impl: landing/src/content/site.ts --> <!-- @impl: landing/src/scripts/feature-terminals.ts --> <!-- @impl: landing/src/scripts/type-on-view.ts --> <!-- @impl: landing/src/scripts/reveal.ts --> <!-- @impl: landing/src/scripts/scramble.ts --> <!-- @impl: landing/src/scripts/proof.ts --> <!-- @impl: landing/src/scripts/agentfoot.ts --> <!-- @impl: landing/src/scripts/hero-kicker.ts --> <!-- @impl: landing/src/scripts/orch.ts --> <!-- @test: landing/src/__tests__/index-page.test.ts (structural oracle: section order = SECTION_ORDER, four folded substations, 16 .terminal[data-proof], hero loops the reel, rolling-row artifacts, grids/nav/faq counts) --> <!-- @test: landing/src/__tests__/components.test.ts (Container-API component contracts: HeroKicker stack, Transcript stylers, Terminal chrome, GateSteps, Section/SectionHead, FeatureGrid, Header variants) --> <!-- @test: landing/src/__tests__/reveal.script.test.ts (scroll-reveal entrance wiring + above-fold flicker fix + reduced-motion no-op) --> <!-- @test: landing/src/__tests__/proof.script.test.ts (proof-artifact arming + line-roll cycle + re-entrancy guard + reduced-motion no-op) --> <!-- @test: landing/src/__tests__/scramble.script.test.ts (per-word scramble convergence + reduced-motion no-op) --> <!-- @test: landing/src/__tests__/feature-terminals.script.test.ts (type/hold/delete loop DOM mutation + shuffle + reduced-motion no-op) --> <!-- @test: landing/src/__tests__/type-on-view.script.test.ts (cursor-mode last line types in on view, IO-gated, reduced-motion untouched) --> <!-- @test: landing/src/__tests__/orch.script.test.ts (orchestration live feed: collectAgents + tickAgent counters + wrap) --> <!-- @test: landing/src/__tests__/hero-kicker.test.ts (capability-word rotation model + accessible sentence build) --> <!-- @test: landing/src/__tests__/agentfoot.script.test.ts (statusline context tick + wrap + compaction beat + reduced-motion static) -->

**Constraints:**

- Authenticated-user behavior at `/` is unchanged: active users redirect to `/app/`, pending/blocked SaaS users to `/app/subscribe`. The landing's Sign in link (`APP_LINKS.signIn`, resolves to `/login`) goes directly to the SPA login provider-chooser, an existing route, bypassing the `/app/` redirect that previously returned an unauthenticated visitor to the landing before the login UI rendered.
- If the landing build is absent from assets, SPA `not_found_handling` falls back to the legacy in-SPA pages (LoginPage / OnboardingLanding) — deploys without the landing build degrade gracefully, never 404.
- `/landing/*` is listed in `run_worker_first` so landing documents carry the same security headers as `/`.
- The landing build outputs to `web-ui/dist/landing/` and must build after web-ui (which wipes `dist/`).
- Client JS is enhancement-only: the hero top-line capability ticker (server markup ships the full stack; JS only advances the active word and measures its width so the `ENGINE` suffix tracks it), the hero accent-word scramble, the page-wide flare-fluid signature (a fixed full-page WebGL layer driven by the cursor on desktop and by page scroll on touch, paused on a hidden tab, veiled to stay legible behind text), the one-shot proof-artifact sequences armed on scroll-in (the self-healing enforcement gate, the boundary data-path, the egress-inspection strip, the browser-isolation context pipe, the parallel review board, the cost attribution ledger; each artifact ships its resolved final state in the markup so content is never gated), and the scroll-reveal fades are all gated on `prefers-reduced-motion` and absent without JS; the full narrative renders statically.
- The rendered marketing copy is vendor-neutral: the prose, FAQ, and ledger name no underlying cloud platform, so the page reads as a standalone product. The trust-logo strip may include a platform vendor's mark (relationship-neutral, alphabetical), and functional third-party script URLs (e.g. the bot-protection loader) are exempt as non-copy.
- Sections are separated by background tint, vertical rhythm, and a per-section terminal-path tag (the `.kicker` element rendered as `~/<name>`: mono, lowercase, with a CSS `~/` accent prefix), never a horizontal rule: every top-level section opens the same way (the tag, then the h2 and lead, full width — legacy and context included, no longer a half-width pair), the tag being the calm structural cue that replaced the removed numbered spine and the earlier uppercase kicker eyebrow (a generic AI tell, and against this page's own anti-references). The five nav-pillar sections reuse their pillar word as the tag (content keeps the capitalised word, e.g. `Security`; CSS lowercases it). Subordinate `.substation` sub-blocks carry a NESTED tag one path level deeper (`~/security/operations`, `~/cost/tenancy`, `~/platform/runs-everywhere`, `~/context/drives`) so the path depth — not size alone — marks them as sub-sections, and their head uses the `--fs-subhead` size (a decisive step above the card terms), their lead held at the section `--fs-lead`. The type scale is disciplined: sans prose uses only the token sizes (kicker/display/h2/subhead/h3/lead/body/small) with one interactive-control size (`--fs-ui`) for buttons, inputs, and SSO rows, and terminals use three mono sizes total (`--fs-mono` body · `--fs-mono-ui` chrome and dense-table rows · `--fs-mono-micro` captions and column heads), every terminal sharing one body rhythm so none reads as cramped. Every terminal header shares one chrome combination (dots + a calm muted `--fs-mono-ui` title, modelled on the hero terminal): the load-bearing ids (REQ-PAY-014, PR #207) stay but in the muted tone, never per-terminal coral or white or micro-uppercase, so the headers align across the page. Under-terminal sub-block card terms (operations, runs-everywhere, cost) are sentence case in the same heading family as the rest of the page: the page carries exactly one heading case, with the three levels (section `h2` > substation `--fs-subhead` sub-head > card term and its explanation) separated on size + weight + colour together rather than by switching any level to all-caps; the card term is `--fs-body` semibold primary (white) over its `--fs-body` regular secondary (grey) explanation — a term/definition pair distinguished by weight and colour at one size — while the sub-section head sits a decisive step larger at `--fs-subhead`, so no two levels collide in size. The contact section's intro paragraph and its quieter note both take `--fs-lead` (it is that section's lead), the note set apart by a top margin rather than a size step. The trust marks are wordmark-free and share one bounding box (a single aspect-ratio box with `object-fit: contain`, normalizing the visual weight of marks with differing aspect ratios rather than relying on a single shared height, which had let the one wide mark dominate the row); at rest they render in a calm desaturated tone (grayscale with lifted brightness and reduced opacity) and restore full colour on hover or keyboard focus, the tone transition respecting `prefers-reduced-motion`. Disclosure open/close animation (the FAQ items and the login page's enterprise-SSO `<details>`, which share one global `::details-content` rule) is pure CSS via `::details-content` + `interpolate-size`, gated on `prefers-reduced-motion` with a snap fallback, and snaps gracefully on browsers lacking `::details-content`; no JS.
- The proof artifacts are bound to one spine run (`REQ-PAY-014` / `AC3` / `PR #207`, user `t.anderson`, team `payments`; a fictional example run shown as on-page copy, not a requirement this codebase governs), sourced once in `site.ts` so the IDs cannot drift between the hero transcript, the enforcement gate, the egress-inspection strip, the review board, and the cost ledger. The boundary data-path and the browser-isolation context pipe are structural diagrams rendered alongside them, not ID-keyed to the spine.

**Priority:** P1

**Dependencies:** None.

**Verification:** [Worker serving tests](../../src/__tests__/index.test.ts), [Landing render tests](../../landing/src/__tests__/index-page.test.ts)

**Status:** Implemented

---

### REQ-LANDING-002: Demo-request contact pipeline

**Intent:** Enterprise prospects submit demo requests from the landing page through an abuse-protected endpoint that relays to the operators without storing personal data, keeping the landing's privacy promise ("not stored") literally true.

**Applies To:** User

**Acceptance Criteria:**

1. POST `/public/contact` validates name (1-100), email, company (optional, ≤200), topic (shared `CONTACT_TOPICS` enum), and message (10-4000); invalid input is rejected with 400. <!-- @impl: src/routes/public/index.ts --> <!-- @impl: src/lib/contact-topics.ts::CONTACT_TOPICS --> <!-- @test: src/__tests__/routes/public-contact.test.ts (400 on invalid name/topic/message, 200 for every CONTACT_TOPICS topic) --> <!-- @test: landing/src/__tests__/contact-controller.test.ts (buildContactPayload only produces accepted topics, pickDeepLinkTopic rejects crafted topics) -->
2. The endpoint is available when SaaS mode or onboarding mode is active and returns 404 otherwise; the waitlist endpoint stays onboarding-only. <!-- @impl: src/routes/public/index.ts --> <!-- @test: src/__tests__/routes/public-contact.test.ts (404 when neither mode active, 200 in SaaS mode) -->
3. Submissions require a passing Turnstile verification; failures are rejected with a CAPTCHA validation error. <!-- @impl: src/routes/public/index.ts --> <!-- @test: src/__tests__/routes/public-contact.test.ts (failed Turnstile rejected 400 with CAPTCHA error) -->
4. Accepted submissions are relayed as email to all admin users with reply-to set to the submitter, and every user-controlled field is HTML-escaped before rendering into the email body. <!-- @impl: src/routes/public/index.ts --> <!-- @test: src/__tests__/routes/public-contact.test.ts (emails admins with reply-to submitter, HTML-escapes user fields) --> <!-- @test: landing/src/__tests__/contact-controller.test.ts (submitContact POSTs JSON to /public/contact and reports outcomes) -->
5. Submission content is never persisted — the only KV writes on the contact path are rate-limiter bookkeeping. <!-- @impl: src/routes/public/index.ts --> <!-- @test: src/__tests__/routes/public-contact.test.ts (only rate-limiter KV writes on the contact path) -->
6. GET `/public/contact-config` exposes the Turnstile site key under the same mode gate, for the landing form widget. <!-- @impl: src/routes/public/index.ts --> <!-- @test: src/__tests__/routes/public-contact.test.ts (contact-config returns site key in SaaS mode, 404 when neither mode active) -->

**Constraints:**

- Rate-limited (5/minute per client) via the shared KV rate-limiter infrastructure ([REQ-SEC-007](security.md#req-sec-007-rate-limiting-infrastructure)).
- Topic values live in `src/lib/contact-topics.ts`, imported by both the Worker schema and the landing form — the form cannot offer a topic the API rejects.
- Returns 503 when Turnstile/Resend secrets or admin recipients are not configured (same degradation contract as the waitlist).

**Priority:** P1

**Dependencies:** [REQ-LANDING-001](#req-landing-001-mode-aware-public-landing-serving)

**Verification:** [Contact route tests](../../src/__tests__/routes/public-contact.test.ts), [Controller tests](../../landing/src/__tests__/contact-controller.test.ts)

**Status:** Implemented

---

### REQ-LANDING-003: Landing social-share and search metadata

**Intent:** When codeflare.ch is shared or indexed, the unfurl and search snippet communicate the enterprise agentic-coding-engine positioning with a branded preview card, structured data, and root discoverability documents, while private (default/enterprise) deployments stay out of the index.

**Applies To:** User

**Acceptance Criteria:**

1. The landing exposes the full Open Graph set: `og:type`, `og:site_name`, `og:title`, `og:description`, `og:url`, `og:image` (1200x630 with type/alt), `og:locale`. <!-- @impl: landing/src/layouts/BaseLayout.astro --> <!-- @test: landing/src/__tests__/metadata.test.ts (OG meta tags: og:type/site_name/url/image present, title/description non-empty) -->
2. Twitter Card metadata is set with `summary_large_image` plus title, description, image, and image alt. <!-- @impl: landing/src/layouts/BaseLayout.astro --> <!-- @test: landing/src/__tests__/metadata.test.ts (Twitter Card meta: twitter:card=summary_large_image + image) -->
3. The canonical URL is the served root (`https://codeflare.ch/`), not the `/landing/` asset path. <!-- @impl: landing/src/layouts/BaseLayout.astro --> <!-- @test: landing/src/__tests__/metadata.test.ts (canonical link element with href) -->
4. The meta description and OG description carry the enterprise positioning ("enterprise agentic engine") as the canonical external description of the product. <!-- @impl: landing/src/layouts/BaseLayout.astro --> <!-- @test: landing/src/__tests__/metadata.test.ts (meta description present, non-empty content) -->
5. The landing emits a JSON-LD `@graph` of schema.org structured data: a site-wide `Organization` (named, logo, `sameAs` the public repo) and `WebSite`, with the home page grafting on a `SoftwareApplication` entity, so search engines and LLMs resolve Codeflare to a named entity. <!-- @impl: landing/src/layouts/BaseLayout.astro --> <!-- @test: landing/src/__tests__/metadata.test.ts (JSON-LD @graph parses with Organization + WebSite types) -->
6. The Worker serves discoverability documents at the deployment root, gated on the public landing being active (SaaS or onboarding): `robots.txt` (allows the marketing surface, excludes `/app`, `/api`, `/auth`, `/login`, `/setup`, and points at the sitemap), `sitemap.xml` (the indexable routes at the canonical origin, login excluded), and `llms.txt` (the llms.txt-convention product summary). In a private (default/enterprise) deployment `robots.txt` disallows all crawling and `sitemap.xml` / `llms.txt` return 404. <!-- @impl: src/lib/seo.ts --> <!-- @impl: src/index.ts --> <!-- @test: src/__tests__/lib/seo.test.ts (buildRobotsTxt public/private, buildSitemapXml urlset/canonical/no-login, buildLlmsTxt convention) --> <!-- @test: src/__tests__/index.test.ts (Edge robots/sitemap/llms public vs private serving) -->
7. The landing declares a `theme-color` and an `apple-touch-icon` for mobile share/install surfaces. <!-- @impl: landing/src/layouts/BaseLayout.astro --> <!-- @test: landing/src/__tests__/metadata.test.ts (theme-color + apple-touch-icon emitted) -->

**Constraints:**

- The OG/Twitter preview image is the brand asset at `web-ui/public/og.png` (1200x630), served from the SPA asset root at `/og.png`.
- JSON-LD is a `<script type="application/ld+json">` data block (not executed), so it is unaffected by the landing's `script-src 'self'` CSP.
- The discoverability documents are served before the setup-completion gate (so a crawler reaches them on a fresh instance) and use the hardcoded canonical origin (`https://codeflare.ch`), so an integration/staging host never advertises itself as canonical.
- [REQ-SETUP-010](setup.md#req-setup-010-social-share-preview-metadata-on-the-public-landing-page) continues to govern the SPA's own metadata (`web-ui/index.html`), which still serves `/app` and `/login`.

**Priority:** P2

**Dependencies:** [REQ-LANDING-001](#req-landing-001-mode-aware-public-landing-serving)

**Verification:** [Metadata render tests](../../landing/src/__tests__/index-page.test.ts), [SEO document unit tests](../../src/__tests__/lib/seo.test.ts), [Worker discoverability serving tests](../../src/__tests__/index.test.ts)

**Status:** Implemented

---

### REQ-LANDING-004: First-paint stability and immutable asset caching

**Intent:** Full-page navigations between the marketing landing and the SPA (Sign in → `/login`, and "Back to codeflare.ch") never flash the browser's default white canvas — nor the gray navigation canvas that Chromium forks (Vivaldi/Arc/Brave) expose while the next document has not yet painted, nor the intermittent light-gray flash the default view-transition cross-fade produced on these dark pages — and the landing's content-hashed build assets are cached immutably so its stylesheet is not revalidated on every navigation. This eliminates the inter-page flash (the white default, the fork gray canvas, and the cross-fade light-gray flash, in both light and dark appearance) and the delayed background/haze paint.

**Applies To:** User

**Acceptance Criteria:**

1. The landing layout declares the dark color scheme — a `<meta name="color-scheme" content="dark">` and an inline `html { color-scheme: dark; background-color: … }` rule emitted before any external stylesheet — so a cross-document navigation holds a dark canvas instead of flashing the browser's white default. <!-- @impl: landing/src/layouts/BaseLayout.astro --> <!-- @test: landing/src/__tests__/index-page.test.ts (color-scheme dark meta + inline html{} dark root paint) -->
2. The Worker serves content-hashed `/_astro/` build assets with `Cache-Control: public, max-age=31536000, immutable`, while non-hashed asset responses keep their revalidating default so HTML stays fresh. <!-- @impl: src/index.ts::default --> <!-- @test: src/__tests__/index.test.ts (/_astro/ immutable cache, SPA-fallback not cached, non-hashed revalidates) -->
3. Every same-origin full-page navigation between the landing and `/login` opts into a cross-document view transition (`@view-transition { navigation: auto }` in the landing's global stylesheet). The browser holds the current page while the next document loads and then swaps instantly, so a Chromium fork (Vivaldi/Arc/Brave) never exposes its gray navigation canvas during the document swap — in light or dark appearance. The default root cross-fade is suppressed for every visitor (`::view-transition-old(root), ::view-transition-new(root) { animation: none }`), not only under `prefers-reduced-motion`: on these dark pages the cross-fade had a timing-dependent window where the two ~50%-opacity root snapshots composited over the browser's light base canvas, producing an intermittent light-gray flash on repeat navigations — the instant swap removes that window while keeping the flash-free hold. It is pure CSS with a graceful fallback to a normal navigation on browsers without cross-document view-transition support. <!-- @impl: landing/src/styles/global.css (@view-transition) --> <!-- coverage-gap: cross-document view transitions are a browser navigation behavior with no unit-testable surface; verified visually in the affected Chromium forks (no gray flash on landing<->/login) -->

**Constraints:**

- The SPA shell (`web-ui/index.html`) carries the same dark `color-scheme` meta and inline root paint, so navigating landing → `/login` (SPA) and back never flashes white; this is the SPA half of the same cross-document fix and complements [REQ-SETUP-010](setup.md#req-setup-010-social-share-preview-metadata-on-the-public-landing-page), which owns the shell's social-share metadata.
- The installable manifest's `theme_color` and `background_color` (`web-ui/public/manifest.webmanifest`) match the dark first-paint background so the PWA splash/install surface is consistent with the app's dark canvas.
- Immutability is keyed on the `/_astro/` path segment (Astro's content-hashed output directory): only those filenames change when content changes, so a stale cache entry is impossible; HTML and other non-hashed responses must keep revalidating so content stays fresh.
- Immutability is applied only to a real `200` asset whose response is not `text/html`, never the SPA fallback that `not_found_handling = "single-page-application"` returns for a non-existent `/_astro/` URL — caching that HTML shell forever-immutable under an asset URL would be a stale-shell trap.

**Priority:** P2

**Dependencies:** [REQ-LANDING-001](#req-landing-001-mode-aware-public-landing-serving)

**Verification:** [Landing first-paint render test](../../landing/src/__tests__/index-page.test.ts), [Worker asset-cache serving test](../../src/__tests__/index.test.ts)

**Status:** Implemented
