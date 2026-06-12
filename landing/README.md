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
| Logic | `src/scripts/*.ts`, `src/lib/splash-*.ts` | Browser modules: the pure, unit-tested `contact-controller.ts`; `scramble.ts` (hero accent-word effect); and `splash.ts` + the `splash-*` / `webgl-utils` fluid set (the page-wide flare-fluid; sets `html.flare-on` to switch the page onto its glass surfaces, paused while the tab is hidden — reduced-motion, no-fine-pointer, and no-WebGL visitors never set it and keep the solid surfaces). All but the contact controller are presentational and desktop/reduced-motion gated. |
| Components | `src/components/*.astro` | `Hero`, `ContactForm`, `Footer`. Markup rendering content data. |
| Pages | `src/pages/*.astro` | `index.astro` (composition), `privacy.astro`. |

## Design

Calm, confident enterprise dark-tech. Sans-serif carries all prose; monospace is
reserved for ONE legible terminal demo (the hero) and two static code snippets
(the review pipeline and the spec/TDD enforcement trace), where it signals real
engineering. A single locked accent, generous whitespace, hairline borders, one
corner-radius scale. Each section uses a distinct layout family (stat band,
two-column compare, a spec-driven-development "method" section with pillar cards +
an enforcement trace, security cards + a boundary data-path flow diagram, feature
columns, point list + code block, cost layers, tenancy checklist, FAQ accordion).
The full page renders statically with no JS. The motion: a quiet scroll-reveal, a
scramble on the single hero accent word (the Codeflare ScrambleText effect, ported
to vanilla DOM), and a cursor-reactive WebGL flare-fluid behind the whole page (a
fixed full-page layer: vivid behind the hero, then veiled by a scroll-linked wash
to a calm, legible background beneath the text-dense sections below; desktop/fine-
pointer only, paused on a hidden tab). When the fluid is live (desktop) the content
panels become translucent glass floating over it; touch / no-JS / reduced-motion
visitors keep solid surfaces. All of it collapses under `prefers-reduced-motion`.
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

`npm test` (vitest, CI-run): Container-API render tests for the composed page and
metadata (REQ-LANDING-001 AC4 + REQ-LANDING-003), the privacy no-storage
disclosure (REQ-LANDING-002), and unit tests for the contact controller using an
injected `fetch`. No JS framework ships to the browser.
