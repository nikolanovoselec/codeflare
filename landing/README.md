# Codeflare Landing

**Audience:** Landing contributors

**Owns:** landing composition, content/tokens, browser behavior, build output, and contact-route client integration.

**Does not own:** product-wide runtime, endpoint contracts/handlers, authentication, security controls, or Worker routing policy. Those remain in the canonical documentation lanes.

## Architecture

The landing package is a prerendered Astro application. The Worker serves its output at `/` for unauthenticated visitors when SaaS or onboarding landing mode is active; valid deployment-mode combinations belong to [Configuration](../documentation/lanes/configuration.md).

| Layer | Location | Responsibility |
|---|---|---|
| Design tokens | `src/styles/tokens.css` | Fonts, colors, accent, type/space scales, easing, and layout constants |
| Global styles | `src/styles/global.css` | Mobile-first layout and component styling resolved through tokens |
| Content | `src/content/site.ts` | Typed page copy and shared proof identifiers |
| Client integration | `src/config.ts` | Worker endpoints and application links consumed by the package |
| Browser behavior | `src/scripts/*.ts`, `src/lib/splash-*.ts` | Page-specific interaction, motion, WebGL, and contact behavior |
| Components | `src/components/*.astro` | Content-driven layout primitives, proof artifacts, forms, and login UI |
| Pages | `src/pages/*.astro` | Marketing, login, and privacy composition |

### Execution proof composition

The typed `EXECUTION` model supplies software-delivery and infrastructure sequences; `Transcript.astro` renders shared terminal chrome and authored events, with proof links styled by the shared global stylesheet. Progressive motion restores a fitted prefix, stages one pending row, types that row, then appends events in order without changing frame geometry; reduced motion shows the resolved viewport. These source contracts do not complete the separate manual/deployed checks retained in REQ-LANDING-012/013/014. <!-- @impl: landing/src/content/site.ts::EXECUTION --> <!-- @impl: landing/src/components/Transcript.astro::transcript-feed --> <!-- @impl: landing/src/styles/global.css::terminal-inline-link -->

### Browser logic

Marketing-only modules (`scramble`, `splash`, `proof`, `type-on-view`, `reveal`, `agentfoot`, feature terminals, and orchestration) run only on `index.astro`. `contact-controller.ts` owns form submission behavior. `login.ts` alone interprets the Worker's OAuth status/error response on the login page.

The marketing page server-renders its stable final state. WebGL, motion, and proof sequences are enhancements: reduced motion, unavailable WebGL, context loss, or coarse-pointer backgrounding retires the flare canvas to the CSS surface. Desktop backgrounding pauses the flare and resumes it on return. Login and privacy keep a clean static first paint and do not load the marketing motion system.

## Design

The package implements a calm enterprise dark-tech system with one accent, content-owned copy, token-owned values, and composition-only pages. Sans-serif carries prose; monospace is reserved for terminal/proof artifacts. Layouts remain mobile-first and every motion path yields under `prefers-reduced-motion`.

Current visual details and proof content are source-owned by `src/content/site.ts`, components, and token files rather than duplicated as a prose inventory here. System-wide landing behavior and requirements remain in [Architecture](../documentation/lanes/architecture.md#landing-implementation) and the [Landing SDD domain](../sdd/spec/landing.md).

## Build & serving

`astro build` writes to `../web-ui/dist/landing/` with base `/landing`, which the Worker's existing static-assets binding serves. Build order is significant: build `web-ui` first because it replaces `dist/`, then build `landing`. Astro renders the pages, but no client-side JavaScript framework ships to the browser; interactive behavior uses the package's focused TypeScript modules.

The package consumes `POST /public/contact` and `GET /public/contact-config` through `src/config.ts`. Exact request, response, rate-limit, and failure contracts belong to the [API Reference](../documentation/lanes/api-reference.md#public-landing).

<a id="backend-contract"></a>
## Runtime boundary

Landing source never owns authentication or contact-handler policy. The Worker decides whether landing assets are eligible, validates Turnstile and outbound relay configuration, and returns the public API contracts. The package owns only how those contracts are called and rendered.

<a id="tests"></a>
## Develop and verify

From `landing/`:

```sh
npm install
npm run dev
npm test
npm run build
```

- `npm run dev` starts Astro's package development server.
- `npm test` runs behavioral component, composition, metadata, and browser-script tests.
- `npm run build` must produce the `/landing` output after the frontend build order described above.

Tests assert rendered structure, behavior, and focused content passthrough rather than treating broad marketing copy as the contract. Protected deployment claims remain manual/browser evidence owned by [CI/CD](../documentation/lanes/ci-cd.md), not package-source regexes.

## Manual browser acceptance

Use existing approved targets and content. Protected access, authentication, delivery and writes need separate current authorization. These are observation methods, not execution evidence; missing prerequisites remain unverified. CI, deployment, promotion and capture/asset-replacement approval remain separately owned.

### Landing responsive navigation acceptance

For REQ-LANDING-001 AC5–AC7, inspect mobile, tablet and desktop breakpoints with normal motion, reduced motion and JavaScript disabled. Trigger terminal proofs, capability text, orchestration, reveals and flare; complete resting content must remain present without JavaScript and readable under reduced motion. Keyboard-traverse navigation, trust, disclosures, contact, sign-in and footer controls. Pass only if destinations are correct and sections/controls remain distinct and visible without clipping, overlap or hidden content at every width. Do not submit contact or authenticate without separate approval.

### Landing mobile metadata acceptance

For REQ-LANDING-003 AC7, inspect the served document head. Verify `theme-color` and `apple-touch-icon` match BaseLayout and the referenced icon loads. Pass only if both declarations and the icon resolve. Do not install the site or infer all mobile share/install UIs are qualified from markup.

### Landing login transition acceptance

For REQ-LANDING-004 AC3, use a browser supporting cross-document view transitions on an approved same-origin landing/login pair. Follow sign-in and return as full-page navigations; inspect both documents for the opt-in. Pass only if both opt in and navigation neither flashes an unstyled/light page nor hides required content. Reduced motion must retain static readability. Unsupported browsers or cross-origin provider redirects need no invented animation; protected login requires separate approval.

### Execution reel layout acceptance

For REQ-LANDING-010 AC3, inspect Hero and Execution reel at landing breakpoints. Pass only if desktop/tablet show software and infrastructure terminals side by side at half the Hero scale, while mobile stacks them cleanly. Compare rendered bounds and readability, not CSS class names. This is simulation presentation, not actual software/infrastructure execution.

### Execution reel reduced-motion acceptance

For REQ-LANDING-012 AC1/AC2, enable reduced motion before loading, scroll the reel into view and observe both terminals through the enhancement interval. Pass only if neither animates and both populated resolved event viewports remain visible/readable. Repeat without JavaScript to check intrinsic resolved sizing. Script-constructed feeds do not establish rendered readability; this procedure alone cannot change Partial status.

### Execution reel capture acceptance

For REQ-LANDING-013 AC1–AC3, inspect the Integration reel at a wide aspect, then reload and re-enter its viewport under identical conditions. Observe first, transition and final states in both sequences. Pass only if the frame is self-contained/readable, all three states are meaningful and content/order/typed activity repeat deterministically. Hero shuffle is not Execution sequencing. GIF encoding and asset replacement still require reviewed implementation, green CI, Integration deployment and visual approval; this inspection performs and authorizes none of them.

### Execution reel responsive acceptance

For REQ-LANDING-014 AC1–AC7, observe normal-motion typing at mobile/tablet widths, resize during progression and inspect desktop containment. Hero and both Execution outer heights must remain equal at mobile/tablet without page shifts. Retained rows must stay clipped with contiguous rhythm; newly typed wrapped rows, including prompts, must remain visible without changing frame height.

At opening, compare authored context with the largest fully fitting prefix plus one staged empty row. Every omitted context row must type in order before authored events. Compare all 40 approved rows, including continuations, with `EXECUTION`. Pass only if every outcome holds without horizontal overflow. Repeat reduced-motion/no-JavaScript for complete intrinsic resolved viewports. Never manually scroll the scripted terminal. If context plus staging cannot fit, record failure rather than weaken the contract.

### Landing sign-in accessibility acceptance

For REQ-LANDING-006 AC2/AC3, keyboard-focus the header CTA: its accessible name must remain Sign in. Hover/focus to trigger scrambling; compare primary-white color, shared interaction and unchanged destination. Repeat reduced-motion/no-JavaScript: the label must remain static/readable. Pass only if the flourish never obscures purpose or shifts sibling links. Authentication is not part of this check.

### Landing IDE band acceptance

For REQ-LANDING-007 AC3–AC5, inspect desktop/mobile IDE bands. Compare tab filename, unsaved dot, explorer/open-file selection and source lines with the content model. Pass only if every model node has one explorer row and the calm pane has sequential legible gutter numbers from the existing CSS counter, not hardcoded markup. Mobile's folded explorer is intentional; inspect its desktop state, not a fictional toggle. Repeat no-JavaScript/reduced-motion resting readability. This simulation is not live editor acceptance.

## Canonical references

- [Architecture — Landing implementation](../documentation/lanes/architecture.md#landing-implementation)
- [API Reference — Public Landing](../documentation/lanes/api-reference.md#public-landing)
- [Security](../documentation/lanes/security.md)
- [Landing requirements](../sdd/spec/landing.md)
- [Documentation router](../documentation/README.md)
