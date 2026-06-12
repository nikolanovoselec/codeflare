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
| Logic | `src/scripts/contact-controller.ts` | The one browser module: pure, unit-tested contact payload + submission logic. |
| Components | `src/components/*.astro` | `Hero`, `ContactForm`, `Footer`. Markup rendering content data. |
| Pages | `src/pages/*.astro` | `index.astro` (composition), `privacy.astro`. |

## Design

Calm, confident enterprise dark-tech. Sans-serif carries all prose; monospace is
reserved for ONE legible terminal demo (the hero) and one static review-pipeline
code snippet, where it signals real engineering. A single locked accent, generous
whitespace, hairline borders, one corner-radius scale. Each section uses a
distinct layout family (stat band, two-column compare, security cards + a boundary
data-path flow diagram, feature columns, point list + code block, cost layers,
tenancy checklist, FAQ accordion). The full page renders statically with no JS;
a quiet scroll-reveal (Motion, vanilla) is the only animation and collapses under
`prefers-reduced-motion`. Product brief and voice in `PRODUCT.md`.

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
