# Codeflare Landing

The public marketing site for codeflare.ch — a prerendered Astro app served by
the Worker at `/` for unauthenticated visitors in SaaS and onboarding modes
(REQ-LANDING-001). Enterprise/default deployments never serve it.

## Architecture

Strict separation of concerns — each layer changes independently:

| Layer | Location | Rule |
|---|---|---|
| Design tokens | `src/styles/tokens.css` | THE control panel: every font, color, gradient, layout constant. No raw values anywhere else. |
| Structure styles | `src/styles/global.css` | Layout/structure only; resolves through tokens. |
| Content | `src/content/site.ts` | All copy, typed. Components never carry their own text. |
| Integration config | `src/config.ts` | Every Worker endpoint / app link the page touches. |
| Logic | `src/scripts/*.ts` | Pure, unit-tested modules (terminal player, contact controller). |
| Components | `src/components/*.astro` | Markup-only structure rendering content data. |
| Pages | `src/pages/*.astro` | Composition. |

## Build & serving

`astro build` outputs to `../web-ui/dist/landing/` with base `/landing`, so the
Worker's existing `[assets]` binding serves it with zero wrangler changes. The
Worker rewrites `GET /` → `/landing/` for unauthenticated visitors; if the
landing build is absent, SPA `not_found_handling` falls back to the old
in-SPA pages. Build order matters: web-ui first (it wipes `dist/`), landing second.

## Backend contract

- `POST /public/contact` — demo-request form (Turnstile + Resend relay,
  never persisted). Topics from the shared `src/lib/contact-topics.ts`
  (REQ-LANDING-002).
- `GET /public/contact-config` — Turnstile site key.

## Tests

`npm test` (vitest, CI-run): Container-API render tests for the composed page
and metadata (REQ-LANDING-003), plus unit tests for the player and contact
controller. No JS framework ships to the browser — the only scripts are the
two tested modules plus thin DOM adapters in components.
