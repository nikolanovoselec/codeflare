# Codeflare Landing

The public marketing site for codeflare.ch: a prerendered Astro app served by
the Worker at `/` for unauthenticated visitors in SaaS and onboarding modes
(REQ-LANDING-001). Enterprise/default deployments never serve it.

## Architecture

Strict separation of concerns; each layer changes independently:

| Layer | Location | Rule |
|---|---|---|
| Design tokens | `src/styles/tokens.css` | The control panel: fonts, colors, the one accent, type/space scale, easings, layout constants. No raw values elsewhere. |
| Global styles | `src/styles/global.css` | Layout and component styles; resolves through tokens. Mobile-first. |
| Content | `src/content/site.ts` | All copy, typed. Components never carry their own text. |
| Integration config | `src/config.ts` | Every Worker endpoint / app link the page touches. |
| Logic | `src/scripts/*.ts`, `src/lib/splash-*.ts` | Browser modules: the pure, unit-tested `contact-controller.ts`; `scramble.ts` (hero accent-word effect); `splash.ts` + the `splash-*` / `webgl-utils` fluid set (the page-wide flare-fluid; sets `html.flare-on` to switch the page onto its glass surfaces, paused while the tab is hidden — desktop pointers drive it with the cursor, touch devices from page scroll, and reduced-motion or no-WebGL visitors never set it and keep the solid surfaces); and `proof.ts` (arms the body's proof artifacts: adds `.is-live` to each `[data-proof]` once on scroll-in to play a one-shot reveal sequence; the markup renders the resolved state by default, so it is fully legible with no JS, and reduced-motion visitors keep that static state); `type-on-view.ts` (types the last line of each `animate='cursor'` proof terminal in when it scrolls into view — clears the `[data-typeline]` span ahead of the viewport so it never flashes the full text first; reduced-motion and no-JS keep the resolved line); and `reveal.ts` (scroll-driven entrance for `.reveal` elements and `[data-stagger]` grids, extracted from `BaseLayout.astro` for testability — one-shot per element and flicker-safe for above-the-fold content — plus the sticky-nav `.is-scrolled` depth seam); `agentfoot.ts`, `feature-terminals.ts`, and `orch.ts` are also presentational and reduced-motion gated. `login.ts` reads the `?status` / `?error` query parameters from the Worker's OAuth round-trip and reshapes the page (swaps in the confirmation panel or shows an error); it has no animation and no reduced-motion gate. |
| Components | `src/components/*.astro` | Markup rendering content data; components never carry their own text (it comes from `src/content/site.ts`). Layout primitives (`Section`, `SectionHead`, `Header`, `Footer`); the terminal system (`Terminal` chrome + `Transcript` [last-line cursor / typed / roll-middle styler] + `GateSteps` [rolling-rows styler] + `LedgerTable` / `ReviewBoard` / `OrchTree` bodies); sections (`Hero` / `HeroHeadline`, `FeatureTerminals`, `FeatureGrid` / `FeatureCard`, `TrustStrip`, `MicroCta`, `ContactForm`); login UI (`LoginCard`, `SsoAccordion`, `RequestedPanel`). Pages are pure composition of these. |
| Pages | `src/pages/*.astro` | `index.astro` (composition), `login.astro` (onboarding sign-in: GitHub OAuth + enterprise-SSO request flow), `privacy.astro`. |

## Design

Calm, confident enterprise dark-tech. Sans-serif carries all prose; monospace is
reserved for ONE legible terminal demo (the hero) and two static code snippets
(the review pipeline and the spec/TDD enforcement trace), where it signals real
engineering. A single locked accent, generous whitespace, hairline borders, one
corner-radius scale. Each section uses a distinct layout family (stat band,
two-column compare, and a set of mono "proof artifacts" that show the engine
working rather than describing it. The enforcement gate, egress-inspection strip,
review board, and cost ledger are keyed to one spine PR (`REQ-PAY-014` /
`PR #207`, sourced once in `site.ts`) so their IDs cannot drift; the boundary
data-path and the isolation pipe are structural diagrams that read alongside
them, so the set reads as camera angles on one run:
a spec-driven-development "method" section whose self-healing enforcement gate
visibly fails and then corrects a drift, with the three pillars as numbered
clauses; security cards + a boundary data-path flow that also names what it makes
impossible, plus an egress-inspection strip showing one model call inspected
(guardrails pass, a DLP redaction, route approved); an operations section on
policy-scoped infrastructure access; a context section whose browser-isolation
pipe distils the open web to agent-ready markdown; a parallel review board of six
reviewer lanes converging on one human triage gate; a cost attribution ledger
that closes on zero unattributed, feature columns, cost layers, tenancy
checklist, FAQ accordion). The governance sections carry the page; the platform
capability sections follow as the payoff the boundary makes safe.
The full page renders statically with no JS (every proof artifact ships its
resolved final state in the markup). The motion: a quiet scroll-reveal, a
scramble on the single hero accent word (the Codeflare ScrambleText effect, ported
to vanilla DOM), one-shot proof-artifact reveal sequences armed on scroll-in
(`proof.ts`), and a WebGL flare-fluid behind the whole page (a fixed full-page
layer: vivid behind the hero, then veiled by a scroll-linked wash to a calm,
legible background beneath the text-dense sections below; paused on a hidden tab).
Desktop pointers drive it with the cursor; touch devices have no cursor, so the
fluid is driven by page scroll (a virtual pointer sweeps a gentle path across the
canvas as the page moves). When the fluid is live the content panels become
translucent glass floating over it; no-JS / no-WebGL / reduced-motion visitors
keep solid surfaces. All of it collapses under `prefers-reduced-motion`.
Product brief and voice in `PRODUCT.md`.

## Build & serving

`astro build` outputs to `../web-ui/dist/landing/` with base `/landing`, so the
Worker's existing `[assets]` binding serves it with zero wrangler changes. The
Worker rewrites `GET /` → `/landing/` for unauthenticated visitors; if the
landing build is absent, SPA `not_found_handling` falls back to the old in-SPA
pages. Build order matters: web-ui first (it wipes `dist/`), landing second.

## Backend contract

- `POST /public/contact` — demo-request form (Turnstile + Resend relay, never
  persisted). Topics from the shared `src/lib/contact-topics.ts` (REQ-LANDING-002).
- `GET /public/contact-config` — Turnstile site key for the form widget.

## Tests

`npm test` (vitest, CI-run): behavioral component tests (Container-API render →
parsed DOM, asserting structure and behaviour — caret placement, slot routing,
row/column counts, variant wiring — never copy strings), structural oracles for
the composed `index` / `login` pages and metadata (REQ-LANDING-001 AC4 +
REQ-LANDING-003, REQ-AUTH-020), the privacy no-storage disclosure
(REQ-LANDING-002), behavioral script tests under fake timers (`proof`, `type-on-view`,
`feature-terminals`, `orch`, `reveal`, `scramble`, `agentfoot`, `login`), and unit
tests for the contact controller using an injected `fetch`. No copy-string
theater; no JS framework ships to the browser.
