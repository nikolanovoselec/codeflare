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
<!-- @impl: landing/src/components/FeatureTerminals.astro -->
<!-- @impl: landing/src/scripts/feature-terminals.ts -->
<!-- @impl: landing/src/scripts/scramble.ts -->
<!-- @impl: landing/src/scripts/splash.ts -->
<!-- @impl: landing/src/lib/splash-cursor-logic.ts -->
<!-- @impl: landing/src/scripts/proof.ts -->
<!-- @impl: landing/src/scripts/agentfoot.ts -->
<!-- @impl: landing/src/scripts/orch.ts -->
<!-- @impl: landing/src/content/site.ts -->
<!-- @impl: wrangler.toml -->
<!-- @test: src/__tests__/index.test.ts (REQ-LANDING-001 its -> AC1 SaaS-unauth landing rewrite + AC2 onboarding-unauth landing rewrite + AC3 default-mode redirect) -->
<!-- @test: landing/src/__tests__/index-page.test.ts (REQ-LANDING-001 describe -> AC4 hero/terminal (governed-run transcript: t-warn drift + t-deny egress + alignment refrain)/spine strip/hero prompt run (data-ft-loop + data-ft-once + data-ft-shuffle + ft-typed, run[0] resting state, plays once, beats shuffled per load)/nav/feature-terminal grid (shift section: tile titles + lines + caption feet)/hero terminal statusline foot (agentfoot: ctx + model + reason)/method self-healing enforcement gate (is-fail/is-pass) + label-prose clauses/legacy-rescue section (id=legacy, /sdd init + /sdd clean transcript + foot, full-width terminal under a section head, not a proof-pair)/security merged boundary gate (pass rows + deny rows is-deny + egress rows is-redact under a left-aligned gate-echo command echo whose egress list carries data-roll, no separate gate egress)/numbered station spine removed (no station-marker, no data-station; sections in document order; operations/tenancy/runs-everywhere/trusted folded into their parent section as .substation sub-content, nothing floating)/kicker eyebrow spine (every top-level section opens with its SECTION_KICKERS label inside a .kicker; five nav-pillar sections reuse their pillar word)/context browser-isolated ingestion full width under a section head (open web distilled to markdown) + agent-steered e2e as a subordinate .substation sub-head (CONTEXT.e2e heading + transcript lines + foot, the drive surface with a mobile-viewport verdict)/parallel review board + dispatch/orchestration own dynamic section (Running N agents + per-agent tool/token counters + ctrl+o/ctrl+b affordances + data-orch hooks + normal agent commands, no ctx_batch_execute, between review and spend)/cost ledger + sample note/totals/platform arrives-equipped session-boot terminal (PLATFORM.seed title + rows actor+text + caption inside id=platform..id=mcp, data-proof + data-roll + gate-step, feature-grid--2 absent, seed copy clean of em/en dashes)/mcp tool-governance terminal (MCP.portal rows actor+text + code-mode echo + caption inside id=mcp..id=dogfood, data-proof + data-roll + gate-step, feature-grid absent, as-the-user + code-mode beats)/security boundary post-quantum transport row (sessions keyed, honest claim)/rendered marketing copy names no Cloudflare product (logo brand name + script URLs scrubbed)/dogfood proof (id=dogfood DOGFOOD.lines + foot + PR #533, single GitHub CTA, no footer GitHub link) + trust-logo strip tail (4 logos alphabetical + "In good company" label + per-logo links)/FAQ/form/launch path Sign in) -->
<!-- @test: landing/src/__tests__/proof.script.test.ts (REQ-LANDING-001 describe -> proof-artifact arming (is-live on scroll-in + no-IntersectionObserver fallback) + line-roll cycle (top child to bottom) + re-entrancy guard (no double cycle, via __rollTest seam) + <3-child no-roll + reduced-motion no-op) -->
<!-- @test: landing/src/__tests__/scramble.script.test.ts (REQ-LANDING-001 describe -> per-word span deviation from target then exact convergence + reduced-motion no-op (no spans, text untouched) + empty-element safety) -->
<!-- @test: landing/src/__tests__/feature-terminals.script.test.ts (REQ-LANDING-001 describe -> type/hold/delete loop DOM mutation + convergence to second loop word + data-ft-once hero plays through run and rests on final beat (no loop-back) + data-ft-shuffle randomises the beat order (deterministic under a stubbed RNG, still play-once) + reduced-motion no-op (loop[0] resting state) + empty-loop/invalid-JSON skip) -->
<!-- @test: landing/src/__tests__/orch.script.test.ts (REQ-LANDING-001 describe -> orchestration live feed: collectAgents resolves rows + tickAgent advances activity through the command list and increments tool-use/token counters + wraps + partial-markup skip) -->
<!-- @test: landing/src/__tests__/agentfoot.script.test.ts (REQ-LANDING-001 describe -> statusline context tick + 41->12 wrap + compaction beat restores original reason + reduced-motion static) -->
### REQ-LANDING-001: Mode-aware public landing serving

**Intent:** Unauthenticated visitors to the deployment root in SaaS or onboarding mode see the enterprise marketing landing page — positioning Codeflare as the enterprise agentic coding engine — while authenticated users and default-mode deployments keep their existing app entry flow.

**Applies To:** User

**Acceptance Criteria:**

1. An unauthenticated GET `/` in SaaS mode is served the prerendered landing app (the asset request is rewritten to `/landing/`).
2. An unauthenticated GET `/` in onboarding mode is served the same landing app.
3. In default mode, GET `/` redirects to `/app/` and the landing is never served.
4. The landing renders the full enterprise narrative statically (no JS required): a hero whose big headline states what Codeflare is not and answers it immediately beneath with a plain one-sentence definition line, rendered in the terminal command white (a platform where autonomous agents build, review, test, and ship inside your trust boundary, with an enforcement loop that keeps spec, tests, and code in lockstep so drift is impossible), beside a single legible terminal demo whose transcript follows one governed run (a spec drift flagged as a blocking finding, an isolated-browser markdown ingestion, a denied direct-provider egress redirected to the AI Gateway, the "spec, code, docs aligned" refrain) carrying an agent statusline foot (context, model, reasoning level), a spine strip naming that run, and a capability reel on its bottom command line (one highlight per beat) that plays once and is shuffled on each load (the shared feature-terminal typing engine in play-once mode, `data-ft-once` + `data-ft-shuffle`; the authored `run[0]` is the no-JS resting state); a feature-terminal grid in the shift section (four compact terminals, each showing one codeflare capability as a real command and its output with a one-line caption foot, replacing the former stat band and checkmark comparison); a spec-driven-development "method" section presenting SDD/TDD enforcement as a self-healing enforcement gate, with its two pillars as plain label-and-prose clauses (no numbered counter); a legacy-rescue section (`/sdd init` reverse-engineering a legacy codebase into a spec-driven baseline and `/sdd clean` realigning a drifted spec, shown as a full-width narrative terminal under a standard section head) placed between method and security; a security section whose unified boundary gate (approved and impossible paths as pass/deny rows sharing the same gate grammar as the enforcement gate) and the one egress call inspected below it (shown as a left-aligned command echo above a thin in-terminal divider, the egress rows animating like the boundary rows above) make zero-trust, DLP, and guardrails auditable (the boundary receipt also carrying a post-quantum transport row: sessions keyed with X25519MLKEM768 hybrid key agreement), the boundary and the egress rows folded into one terminal closing on a single in-chrome foot; a browser-isolation context section rendering the open-web-to-markdown fetch and the agent-steered e2e (the same throwaway browser driving a deployed flow from a mobile viewport and returning a pass/fail verdict) as full-width terminals under a standard section head, the e2e introduced by a subordinate `.substation` sub-head so it reads as part of the section; a parallel review board; a live, dynamic agent-orchestration section of its own ("Running N agents" with per-agent tool-use and token counters that tick as they work via `orch.ts`, ordinary agent commands rather than internal tool names, and the `ctrl+o` / `ctrl+b` affordances); a cost attribution ledger; a platform "arrives equipped" section whose seeded capabilities render as a session-boot proof terminal (a rolling loaded-checklist in the same gate grammar, `data-roll`, `PLATFORM.seed`) rather than prose feature cards; an MCP tool-governance section rendering the portal as a dynamic proof terminal in the same gate grammar (many MCP servers collapsed to one endpoint, every call made as the signed-in user with least privilege and attributed, and code mode collapsing the whole tool surface into a single typed `code` tool run in an isolated worker, demonstrated by a code-mode echo); sections that read as calm peers in document order (shift, method, legacy, security, context, pipeline, orchestration, cost, platform, mcp, dogfood, faq, contact), each opening the same way (an accent kicker eyebrow, then the h2 and lead, at full width) so a reader feels where every section starts, cued by that per-section eyebrow and the alternating section backgrounds rather than a numbered spine (the five nav-pillar sections reuse their pillar word as the eyebrow), with the secondary bands (operations, tenancy, runs-everywhere, trusted) folded into their parent section as subordinate `.substation` sub-content (a single `--fs-h3` sub-head, no eyebrow) so nothing floats; all content sections with anchor ids matching the nav links; a dogfood proof section (this page as REQ-LANDING-001, with its real @impl/@test anchors rendered as a terminal widget closing on an in-chrome foot, and the page's only GitHub link as its CTA) with a relationship-neutral trust-logo strip folded in as its tail (four wordmark-free brand marks at uniform height, ordered alphabetically under an "In good company" eyebrow, each linking to its site); an FAQ rendered as two columns on desktop via CSS multi-column flow (so an expanded question grows within its own column without displacing a neighbour), each item animating open and closed via a `::details-content` block-size transition unless the visitor prefers reduced motion (then it snaps), placed after the proof so the dogfood lands before the closing answers; the contact form (two columns at the same 820px breakpoint as the hero and split sections, intro copy left and form right, stacking on narrower viewports); and a Sign in action (nav) linking to the login provider-chooser (`/login`, `APP_LINKS.signIn`); the footer is reduced to one quiet centered "Built with Codeflare" line (no Sign in, GitHub mark, or nav links). The governance sections carry the page; the platform-capability sections follow as the payoff the boundary makes safe.

**Constraints:**

- Authenticated-user behavior at `/` is unchanged: active users redirect to `/app/`, pending/blocked SaaS users to `/app/subscribe`. The landing's Sign in link (`APP_LINKS.signIn`, resolves to `/login`) goes directly to the SPA login provider-chooser, an existing route, bypassing the `/app/` redirect that previously returned an unauthenticated visitor to the landing before the login UI rendered.
- If the landing build is absent from assets, SPA `not_found_handling` falls back to the legacy in-SPA pages (LoginPage / OnboardingLanding) — deploys without the landing build degrade gracefully, never 404.
- `/landing/*` is listed in `run_worker_first` so landing documents carry the same security headers as `/`.
- The landing build outputs to `web-ui/dist/landing/` and must build after web-ui (which wipes `dist/`).
- Client JS is enhancement-only: the hero accent-word scramble, the page-wide flare-fluid signature (a fixed full-page WebGL layer driven by the cursor on desktop and by page scroll on touch, paused on a hidden tab, veiled to stay legible behind text), the one-shot proof-artifact sequences armed on scroll-in (the self-healing enforcement gate, the boundary data-path, the egress-inspection strip, the browser-isolation context pipe, the parallel review board, the cost attribution ledger; each artifact ships its resolved final state in the markup so content is never gated), and the scroll-reveal fades are all gated on `prefers-reduced-motion` and absent without JS; the full narrative renders statically.
- The rendered marketing copy is vendor-neutral: the prose, FAQ, manifests, and ledger name no underlying cloud platform, so the page reads as a standalone product. The trust-logo strip may include a platform vendor's mark (relationship-neutral, alphabetical), and functional third-party script URLs (e.g. the bot-protection loader) are exempt as non-copy.
- Sections are separated by background tint, vertical rhythm, and a per-section accent kicker eyebrow alone, never a horizontal rule: every top-level section opens the same way (the kicker, then the h2 and lead, full width — legacy and context included, no longer a half-width pair), the kicker being the calm structural cue that replaced the removed numbered spine (the five nav-pillar sections reuse their pillar word; subordinate `.substation` sub-blocks take no kicker and use a single `--fs-h3` heading with a body-size lead so they read as inside the section). The type scale is disciplined: sans prose uses only the token sizes (kicker/display/h2/h3/lead/body/small) and terminals use three mono sizes total (`--fs-mono` body · `--fs-mono-ui` chrome and dense-table rows · `--fs-mono-micro` captions and column heads), every terminal sharing one body rhythm so none reads as cramped. The trust marks are wordmark-free and share one height. Disclosure open/close animation (the FAQ items and the login page's enterprise-SSO `<details>`, which share one global `::details-content` rule) is pure CSS via `::details-content` + `interpolate-size`, gated on `prefers-reduced-motion` with a snap fallback, and snaps gracefully on browsers lacking `::details-content`; no JS.
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
