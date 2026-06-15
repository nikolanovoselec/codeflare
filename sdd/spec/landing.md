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

<!-- @impl: landing/src/pages/index.astro -->
<!-- @impl: landing/src/components/Hero.astro -->
<!-- @impl: landing/src/components/HeroHeadline.astro -->
<!-- @impl: landing/src/components/FeatureTerminals.astro -->
<!-- @impl: landing/src/components/Terminal.astro -->
<!-- @impl: landing/src/components/Transcript.astro -->
<!-- @impl: landing/src/components/GateSteps.astro -->
<!-- @impl: landing/src/components/LedgerTable.astro -->
<!-- @impl: landing/src/components/ReviewBoard.astro -->
<!-- @impl: landing/src/components/OrchTree.astro -->
<!-- @impl: landing/src/components/Section.astro -->
<!-- @impl: landing/src/components/SectionHead.astro -->
<!-- @impl: landing/src/components/FeatureGrid.astro -->
<!-- @impl: landing/src/components/FeatureCard.astro -->
<!-- @impl: landing/src/components/MicroCta.astro -->
<!-- @impl: landing/src/components/TrustStrip.astro -->
<!-- @impl: landing/src/components/Header.astro -->
<!-- @impl: landing/src/scripts/feature-terminals.ts -->
<!-- @impl: landing/src/scripts/type-on-view.ts -->
<!-- @impl: landing/src/scripts/reveal.ts -->
<!-- @impl: landing/src/scripts/scramble.ts -->
<!-- @impl: landing/src/scripts/splash.ts -->
<!-- @impl: landing/src/lib/splash-cursor-logic.ts -->
<!-- @impl: landing/src/scripts/proof.ts -->
<!-- @impl: landing/src/scripts/agentfoot.ts -->
<!-- @impl: landing/src/scripts/orch.ts -->
<!-- @impl: landing/src/content/site.ts -->
<!-- @impl: wrangler.toml -->
<!-- @test: src/__tests__/index.test.ts (REQ-LANDING-001 its -> AC1 SaaS-unauth landing rewrite + AC2 onboarding-unauth landing rewrite + AC3 default-mode redirect) -->
<!-- @test: landing/src/__tests__/index-page.test.ts (REQ-LANDING-001 structural oracle for the composed page, the inline->component migration proof -> AC4: main>section ids equal SECTION_ORDER (shift,method,legacy,security,context,pipeline,orchestration,cost,platform,mcp,dogfood,faq,contact) + every section opens with a .section-head (kicker + a top-level h2) + exactly four folded .substation sub-heads (h3, no h2: operations, e2e, tenancy, runs-everywhere) + 16 .terminal[data-proof] (hero + 4 feature + method gate + legacy + boundary + 2 context + board + orch + ledger + platform + mcp + dogfood); hero terminal loops the reel (data-ft-loop JSON equals TERMINAL.run + data-ft-shuffle present + NO data-ft-once, the #39 loop fix) with the typed ft-typed slot resting on run[0] + the agentfoot statusline foot (ctx + reason) + the scramble/flare-fluid client hooks; one looping feature terminal per FEATURE_TERMINALS item (data-ft-loop equals item.loop, ft-typed slot present, no data-ft-once); the three .proof-terminal transcripts each end with exactly one .t-caret on the last line, and that last line is wrapped in a single [data-typeline] span so type-on-view.ts types it in on scroll (#32 cursor styler types its last line in on view); rolling-row artifacts (styler 2): the method gate rolls one .gate-step per METHOD.gate.steps with is-fail + is-pass + the caption foot, the security boundary is one terminal with two [data-roll] lists (boundary rows then EGRESS rows) + a .gate-echo + is-deny + is-redact, the review board rolls a lane per PIPELINE.lanes with the finding-lane count + a board-verdict, the cost ledger rolls a row per COST.ledger.rows + pins the totals with an .is-accent line, the orchestration tree is .orch[data-orch] with one [data-orch-agent] per ORCHESTRATION.agents; the dogfood terminal rolls roll-middle (middle row count = DOGFOOD.lines minus the pinned first/last); grids/nav/proof: one .feature-grid--2 + two .feature-grid--3, one agent chip per AGENTS, the pillar nav (NAV_LINKS count) + the .nav-signin pointing at APP_LINKS.signIn, one trusted-logo link per TRUSTED.logos + one .faq-item per FAQ_ITEMS; content invariants: no em/en dash in the rendered copy + the privacy page still renders and is dash-free) -->
<!-- @test: landing/src/__tests__/components.test.ts (REQ-LANDING-001 behavioral component contracts the page composition relies on, rendered via the Container API into a real DOM -> Transcript styler 1: animate=cursor places exactly one .t-caret on the last .t-line only and wraps that line's text in a single [data-typeline] span (the type-on-view hook) with the caret directly adjacent to that span (no whitespace text node between them, so it hugs the text like the hero), none on the first, no ft-typed/data-roll, animate=typed appends a t-cmd line carrying .ft-typed[data-ft-typed] + a caret after the transcript, animate=roll-middle pins the first+last .t-line outside a [data-roll] that holds the middle, default static renders plain lines with no caret/roll/typed; Terminal chrome: three .terminal-dots, a plain .terminal-title from the title prop + a tf-static foot from the foot prop, reveal=true by default and reveal=false drops .reveal, a bar slot replaces the title when no title prop, a foot slot replaces tf-static, the ftLoop/ftShuffle/orch props emit data-ft-loop/data-ft-shuffle/data-orch (and are mutually absent when unset); GateSteps styler 2: one .gate-step per row under .gate-steps[data-roll] with .gate-actor/.gate-state/.gate-text + the state colour class, a stateless row gets only the base class; Section wraps a .container + alt adds .section--alt; SectionHead renders h2 (top-level) vs h3 (substation), leadHtml as inline markup, omits .lead when no lead, trails its default slot; FeatureGrid renders one .feature-col per card with the --2/--3 modifier + the data-stagger hook; MicroCta in-page vs external (target=_blank rel=noopener) + data-topic + class/reveal modifiers; Header variant landing (brand + NAV_LINKS + .nav-signin=APP_LINKS.signIn) vs login (.login-back + arrow, no nav-links)) -->
<!-- @test: landing/src/__tests__/reveal.script.test.ts (REQ-LANDING-001 entrance wiring + the open-page flicker fix, motion mocked to record observed/animated elements under happy-dom -> a below-the-fold .reveal element is observed via inView and animated only when its callback fires, while an above-the-fold element is never observed or animated (the flicker fix: animating from opacity 0 in the initial viewport would flash) + below-the-fold targets are hidden up front at setup (opacity 0 while off-screen) so they fade up on entry without a scroll-in flash + prefers-reduced-motion observes/animates nothing + a [data-stagger] grid hides its children up front at setup (opacity 0 before the grid enters view) then animates each in on entry) -->
<!-- @test: landing/src/__tests__/proof.script.test.ts (REQ-LANDING-001 describe -> proof-artifact arming (is-live on scroll-in + no-IntersectionObserver fallback) + line-roll cycle (top child to bottom) + re-entrancy guard (no double cycle, via __rollTest seam) + <3-child no-roll + reduced-motion no-op) -->
<!-- @test: landing/src/__tests__/scramble.script.test.ts (REQ-LANDING-001 describe -> per-word span deviation from target then exact convergence + reduced-motion no-op (no spans, text untouched) + empty-element safety) -->
<!-- @test: landing/src/__tests__/feature-terminals.script.test.ts (REQ-LANDING-001 describe -> type/hold/delete loop DOM mutation + convergence to second loop word + data-ft-once play-once mode plays through run and rests on final beat (no loop-back; the engine branch the hero no longer uses now that it loops) + data-ft-shuffle randomises the beat order (deterministic under a stubbed RNG, still play-once) + reduced-motion no-op (loop[0] resting state) + empty-loop/invalid-JSON skip) -->
<!-- @test: landing/src/__tests__/type-on-view.script.test.ts (REQ-LANDING-001 describe -> cursor-mode last line types in on view: no-IO fallback clears the [data-typeline] line then types it back one char per TYPE_MS, converging on the full line and stopping (no loop/overrun) + typing is gated on the IntersectionObserver firing (full line untouched until isIntersecting, then cleared+typed, unobserved once) + reduced-motion never clears or mutates the full line + empty [data-typeline] left untouched) -->
<!-- @test: landing/src/__tests__/orch.script.test.ts (REQ-LANDING-001 describe -> orchestration live feed: collectAgents resolves rows + tickAgent advances activity through the command list and increments tool-use/token counters + wraps + partial-markup skip) -->
<!-- @test: landing/src/__tests__/agentfoot.script.test.ts (REQ-LANDING-001 describe -> statusline context tick + 41->12 wrap + compaction beat restores original reason + reduced-motion static) -->
### REQ-LANDING-001: Mode-aware public landing serving

**Intent:** Unauthenticated visitors to the deployment root in SaaS or onboarding mode see the enterprise marketing landing page — positioning Codeflare as the enterprise agentic coding engine — while authenticated users and default-mode deployments keep their existing app entry flow.

**Applies To:** User

**Acceptance Criteria:**

1. An unauthenticated GET `/` in SaaS mode is served the prerendered landing app (the asset request is rewritten to `/landing/`). <!-- @impl: src/index.ts::default -->
2. An unauthenticated GET `/` in onboarding mode is served the same landing app. <!-- @impl: src/index.ts::default -->
3. In default mode, GET `/` redirects to `/app/` and the landing is never served. <!-- @impl: src/index.ts::default -->
4. The landing renders the full enterprise narrative statically (no JS required): a hero whose big headline states what Codeflare is not and answers it immediately beneath with a plain one-sentence definition line, rendered in the terminal command white (a platform where autonomous agents build, review, test, and ship inside your own trust boundary, with an enforcement loop that keeps spec, tests, and code in lockstep so drift is impossible), beside a single legible terminal demo whose transcript follows one governed run (a spec drift flagged as a blocking finding, an isolated-browser markdown ingestion, a denied direct-provider egress redirected to the AI Gateway, the "spec, code, docs aligned" refrain) carrying an agent statusline foot (context, model, reasoning level), a spine strip naming that run, and a capability reel on its bottom command line (one highlight per beat) that loops continuously and is shuffled on each load (the shared feature-terminal typing engine, `data-ft-loop` + `data-ft-shuffle`; the authored `run[0]` is the no-JS resting state); a feature-terminal grid in the shift section (four compact terminals, each showing one codeflare capability as a real command and its output with a one-line caption foot, replacing the former stat band and checkmark comparison); a spec-driven-development "method" section presenting SDD/TDD enforcement as a self-healing enforcement gate, with its two pillars as plain label-and-prose clauses (no numbered counter); a legacy-rescue section (`/sdd init` reverse-engineering a legacy codebase into a spec-driven baseline and `/sdd clean` realigning a drifted spec, shown as a full-width narrative terminal under a standard section head) placed between method and security; a security section whose unified boundary gate (approved and impossible paths as pass/deny rows sharing the same gate grammar as the enforcement gate) and the one egress call inspected below it (shown as a left-aligned command echo above a thin in-terminal divider, the egress rows animating like the boundary rows above) make zero-trust, DLP, and guardrails auditable (the boundary receipt also carrying a post-quantum transport row: sessions keyed with X25519MLKEM768 hybrid key agreement), the boundary and the egress rows folded into one terminal closing on a single in-chrome foot; a browser-isolation context section rendering the open-web-to-markdown fetch and the agent-steered e2e (the same throwaway browser driving a deployed flow from a mobile viewport and returning a pass/fail verdict) as full-width terminals under a standard section head, the e2e introduced by a subordinate `.substation` sub-head so it reads as part of the section; a parallel review board; a live, dynamic agent-orchestration section of its own ("Running N agents" with per-agent tool-use and token counters that tick as they work via `orch.ts`, ordinary agent commands rather than internal tool names, and the `ctrl+o` / `ctrl+b` affordances); a cost attribution ledger; a platform "arrives equipped" section whose seeded capabilities render as a session-boot proof terminal (a rolling loaded-checklist in the same gate grammar, `data-roll`, `PLATFORM.seed`) rather than prose feature cards; an MCP tool-governance section rendering the portal as a dynamic proof terminal in the same gate grammar (many MCP servers collapsed to one endpoint, every call made as the signed-in user with least privilege and attributed, and code mode collapsing the whole tool surface into a single typed `code` tool run in an isolated worker, shown as the cyan `code mode` governance row); sections that read as calm peers in document order (shift, method, legacy, security, context, pipeline, orchestration, cost, platform, mcp, dogfood, faq, contact), each opening the same way (a terminal-path tag rendered as `~/<name>`, then the h2 and lead, at full width) so a reader feels where every section starts, cued by that per-section tag and the alternating section backgrounds rather than a numbered spine (the five nav-pillar sections reuse their pillar word as the tag), with the secondary bands (operations, tenancy, runs-everywhere, trusted) folded into their parent section as subordinate `.substation` sub-content (a nested terminal-path tag like `~/security/operations` above an `--fs-subhead` sub-head) so nothing floats; all content sections with anchor ids matching the nav links; a dogfood proof section (this page as REQ-LANDING-001, with its real @impl/@test anchors rendered as a terminal widget closing on an in-chrome foot, and the page's only GitHub link as its CTA) with a relationship-neutral trust-logo strip folded in as its tail (four wordmark-free brand marks normalized to one shared bounding box so marks of differing aspect ratio carry equal visual weight, rendered in a calm desaturated tone at rest and restoring colour on hover, ordered alphabetically under an "In good company" eyebrow, each linking to its site); an FAQ rendered as two columns on desktop via CSS multi-column flow (so an expanded question grows within its own column without displacing a neighbour), each item animating open and closed via a `::details-content` block-size transition unless the visitor prefers reduced motion (then it snaps), placed after the proof so the dogfood lands before the closing answers; the contact form (two columns at the same 820px breakpoint as the hero and split sections, intro copy left and form right, stacking on narrower viewports); and a Sign in action (nav) linking to the login provider-chooser (`/login`, `APP_LINKS.signIn`); the footer is reduced to one quiet centered "Built with Codeflare" line (no Sign in, GitHub mark, or nav links). The governance sections carry the page; the platform-capability sections follow as the payoff the boundary makes safe.

**Constraints:**

- Authenticated-user behavior at `/` is unchanged: active users redirect to `/app/`, pending/blocked SaaS users to `/app/subscribe`. The landing's Sign in link (`APP_LINKS.signIn`, resolves to `/login`) goes directly to the SPA login provider-chooser, an existing route, bypassing the `/app/` redirect that previously returned an unauthenticated visitor to the landing before the login UI rendered.
- If the landing build is absent from assets, SPA `not_found_handling` falls back to the legacy in-SPA pages (LoginPage / OnboardingLanding) — deploys without the landing build degrade gracefully, never 404.
- `/landing/*` is listed in `run_worker_first` so landing documents carry the same security headers as `/`.
- The landing build outputs to `web-ui/dist/landing/` and must build after web-ui (which wipes `dist/`).
- Client JS is enhancement-only: the hero accent-word scramble, the page-wide flare-fluid signature (a fixed full-page WebGL layer driven by the cursor on desktop and by page scroll on touch, paused on a hidden tab, veiled to stay legible behind text), the one-shot proof-artifact sequences armed on scroll-in (the self-healing enforcement gate, the boundary data-path, the egress-inspection strip, the browser-isolation context pipe, the parallel review board, the cost attribution ledger; each artifact ships its resolved final state in the markup so content is never gated), and the scroll-reveal fades are all gated on `prefers-reduced-motion` and absent without JS; the full narrative renders statically.
- The rendered marketing copy is vendor-neutral: the prose, FAQ, and ledger name no underlying cloud platform, so the page reads as a standalone product. The trust-logo strip may include a platform vendor's mark (relationship-neutral, alphabetical), and functional third-party script URLs (e.g. the bot-protection loader) are exempt as non-copy.
- Sections are separated by background tint, vertical rhythm, and a per-section terminal-path tag (the `.kicker` element rendered as `~/<name>`: mono, lowercase, with a CSS `~/` accent prefix), never a horizontal rule: every top-level section opens the same way (the tag, then the h2 and lead, full width — legacy and context included, no longer a half-width pair), the tag being the calm structural cue that replaced the removed numbered spine and the earlier uppercase kicker eyebrow (a generic AI tell, and against this page's own anti-references). The five nav-pillar sections reuse their pillar word as the tag (content keeps the capitalised word, e.g. `Security`; CSS lowercases it). Subordinate `.substation` sub-blocks carry a NESTED tag one path level deeper (`~/security/operations`, `~/cost/tenancy`, `~/platform/runs-everywhere`, `~/context/drives`) so the path depth — not size alone — marks them as sub-sections, and their head uses the `--fs-subhead` size (a decisive step above the card terms), their lead held at the section `--fs-lead`. The type scale is disciplined: sans prose uses only the token sizes (kicker/display/h2/subhead/h3/lead/body/small) with one interactive-control size (`--fs-ui`) for buttons, inputs, and SSO rows, and terminals use three mono sizes total (`--fs-mono` body · `--fs-mono-ui` chrome and dense-table rows · `--fs-mono-micro` captions and column heads), every terminal sharing one body rhythm so none reads as cramped. Every terminal header shares one chrome combination (dots + a calm muted `--fs-mono-ui` title, modelled on the hero terminal): the load-bearing ids (REQ-PAY-014, PR #207) stay but in the muted tone, never per-terminal coral or white or micro-uppercase, so the headers align across the page. Under-terminal sub-block card terms (operations, runs-everywhere, cost) are sentence case in the same heading family as the rest of the page: the page carries exactly one heading case, with the three levels (section `h2` > substation `--fs-subhead` sub-head > card term and its explanation) separated on size + weight + colour together rather than by switching any level to all-caps; the card term is `--fs-body` semibold primary (white) over its `--fs-body` regular secondary (grey) explanation — a term/definition pair distinguished by weight and colour at one size — while the sub-section head sits a decisive step larger at `--fs-subhead`, so no two levels collide in size. The contact section's intro paragraph and its quieter note both take `--fs-lead` (it is that section's lead), the note set apart by a top margin rather than a size step. The trust marks are wordmark-free and share one bounding box (a single aspect-ratio box with `object-fit: contain`, normalizing the visual weight of marks with differing aspect ratios rather than relying on a single shared height, which had let the one wide mark dominate the row); at rest they render in a calm desaturated tone (grayscale with lifted brightness and reduced opacity) and restore full colour on hover or keyboard focus, the tone transition respecting `prefers-reduced-motion`. Disclosure open/close animation (the FAQ items and the login page's enterprise-SSO `<details>`, which share one global `::details-content` rule) is pure CSS via `::details-content` + `interpolate-size`, gated on `prefers-reduced-motion` with a snap fallback, and snaps gracefully on browsers lacking `::details-content`; no JS.
- The proof artifacts are bound to one spine run (`REQ-PAY-014` / `AC3` / `PR #207`, user `t.anderson`, team `payments`; a fictional example run shown as on-page copy, not a requirement this codebase governs), sourced once in `site.ts` so the IDs cannot drift between the hero transcript, the enforcement gate, the egress-inspection strip, the review board, and the cost ledger. The boundary data-path and the browser-isolation context pipe are structural diagrams rendered alongside them, not ID-keyed to the spine.

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

<!-- @impl: src/routes/public/index.ts -->
<!-- @impl: src/lib/contact-topics.ts::CONTACT_TOPICS -->
<!-- @impl: landing/src/scripts/contact-controller.ts -->

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
<!-- @impl: landing/src/pages/index.astro -->
<!-- @impl: src/lib/seo.ts -->
<!-- @impl: src/index.ts -->
<!-- @test: landing/src/__tests__/index-page.test.ts (REQ-LANDING-003 describe -> AC1 OG tag set + AC2 Twitter card + AC3 canonical + AC4 enterprise description + AC5 JSON-LD graph (Organization + WebSite + SoftwareApplication, named org linked to source) + AC7 theme-color + apple-touch-icon) -->
<!-- @test: src/__tests__/lib/seo.test.ts (REQ-LANDING-003 describe -> buildRobotsTxt public/private + buildSitemapXml urlset/canonical/no-login + buildLlmsTxt convention + no em/en dash) -->
<!-- @test: src/__tests__/index.test.ts (Edge-level setup redirect describe -> AC6 robots.txt indexable in public mode + disallow-all in private mode, sitemap.xml + llms.txt served in public mode and 404 in private mode) -->
### REQ-LANDING-003: Landing social-share and search metadata

<!-- @impl: landing/src/layouts/BaseLayout.astro -->
<!-- @impl: src/lib/seo.ts -->
<!-- @impl: src/index.ts -->

**Intent:** When codeflare.ch is shared or indexed, the unfurl and search snippet communicate the enterprise agentic-coding-engine positioning with a branded preview card, structured data, and root discoverability documents, while private (default/enterprise) deployments stay out of the index.

**Applies To:** User

**Acceptance Criteria:**

1. The landing exposes the full Open Graph set: `og:type`, `og:site_name`, `og:title`, `og:description`, `og:url`, `og:image` (1200x630 with type/alt), `og:locale`.
2. Twitter Card metadata is set with `summary_large_image` plus title, description, image, and image alt.
3. The canonical URL is the served root (`https://codeflare.ch/`), not the `/landing/` asset path.
4. The meta description and OG description carry the enterprise positioning ("enterprise agentic coding engine") as the canonical external description of the product.
5. The landing emits a JSON-LD `@graph` of schema.org structured data: a site-wide `Organization` (named, logo, `sameAs` the public repo) and `WebSite`, with the home page grafting on a `SoftwareApplication` entity, so search engines and LLMs resolve Codeflare to a named entity.
6. The Worker serves discoverability documents at the deployment root, gated on the public landing being active (SaaS or onboarding): `robots.txt` (allows the marketing surface, excludes `/app`, `/api`, `/auth`, `/login`, `/setup`, and points at the sitemap), `sitemap.xml` (the indexable routes at the canonical origin, login excluded), and `llms.txt` (the llms.txt-convention product summary). In a private (default/enterprise) deployment `robots.txt` disallows all crawling and `sitemap.xml` / `llms.txt` return 404.
7. The landing declares a `theme-color` and an `apple-touch-icon` for mobile share/install surfaces.

**Constraints:**

- The OG/Twitter preview image is the brand asset at `web-ui/public/og.png` (1200x630), served from the SPA asset root at `/og.png`.
- JSON-LD is a `<script type="application/ld+json">` data block (not executed), so it is unaffected by the landing's `script-src 'self'` CSP.
- The discoverability documents are served before the setup-completion gate (so a crawler reaches them on a fresh instance) and use the hardcoded canonical origin (`https://codeflare.ch`), so an integration/staging host never advertises itself as canonical.
- [REQ-SETUP-010](setup.md#req-setup-010-social-share-preview-metadata-on-the-public-landing-page) continues to govern the SPA's own metadata (`web-ui/index.html`), which still serves `/app` and `/login`.

**Priority:** P2

**Dependencies:** [REQ-LANDING-001](#req-landing-001-mode-aware-public-landing-serving)

**Verification:** [Metadata render tests](../../landing/src/__tests__/index-page.test.ts), [SEO document unit tests](../../src/__tests__/lib/seo.test.ts), [Worker discoverability serving tests](../../src/__tests__/index.test.ts)

**Status:** Implemented
