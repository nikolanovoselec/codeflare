# Codeflare Landing

The public marketing site for codeflare.ch — a prerendered Astro app served by
the Worker at `/` for unauthenticated visitors in SaaS and onboarding modes
(REQ-LANDING-001). Enterprise/default deployments never serve it.

## Architecture

Strict separation of concerns — each layer changes independently:

| Layer | Location | Rule |
|---|---|---|
| Design tokens | `src/styles/tokens.css` | THE control panel: every font, color, gradient, easing, duration, layout constant. No raw values anywhere else. |
| Structure styles | `src/styles/global.css` | Layout/structure only; resolves through tokens. |
| Content | `src/content/site.ts` | All copy, typed, plus the count-integrity constants every rendered quantity derives from. Components never carry their own text. |
| Integration config | `src/config.ts` | Every Worker endpoint / app link the page touches. |
| Logic | `src/scripts/*.ts` | Pure, unit-tested modules (terminal player + line commits, fleet scheduler, scene script, FLIP math, odometer, session clock, status-bar state, diff builder, scrollspy, contact controller). |
| Components | `src/components/*.astro` | Markup + thin DOM adapters rendering content data through the tested modules. |
| Pages | `src/pages/*.astro` | Composition. |

## The governed-session UI

The page renders as one continuous terminal session (design contract in
`PRODUCT.md` / `DESIGN.md`): fixed session chrome (`SessionChrome`) and
tmux-style status bar (`StatusBar`, scroll-derived and reversible), prompt-path
labels as section grammar (`PromptLabel`), and one bespoke artifact per section
(`DiffCompare`, `BoundaryDiagram` + `SecurityLedger`, `ManPage`, `SeedLog`,
`PipelineRail`, `CostTrace`, `TenancyPlaque`, `SessionEnd`). The signature
moment: the hero terminal (`FleetTerminal`) plays an autonomous session and, on
the CI-green transcript line, FLIP-splits into a four-pane working fleet —
a native scroll-snap row on phones. Animation is Motion (vanilla);
`transform`/`opacity`/`clip-path` only. The complete page renders statically:
hidden animation states only apply under a pre-paint `html[data-js]` flip, and
`prefers-reduced-motion` gets the full static session.

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
and metadata (REQ-LANDING-003) including count-integrity assertions (rendered
quantities must equal the `site.ts` constants), plus unit tests for every
behavior module (player + line commits, fleet scheduler, scene script, FLIP
math, odometer, session clock, status-bar state, diff builder, scrollspy,
contact controller) — all using injected adapters / fake clocks. No JS
framework ships to the browser: Motion (vanilla) plus the tested modules and
thin DOM adapters in components.
