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

### Browser logic

Marketing-only modules (`scramble`, `splash`, `proof`, `type-on-view`, `reveal`, `agentfoot`, feature terminals, and orchestration) run only on `index.astro`. `contact-controller.ts` owns form submission behavior. `login.ts` alone interprets the Worker's OAuth status/error response on the login page.

The marketing page server-renders its stable final state. WebGL, motion, and proof sequences are enhancements: reduced motion, unavailable WebGL, context loss, or coarse-pointer backgrounding retires the flare canvas to the CSS surface. Desktop backgrounding pauses the flare and resumes it on return. Login and privacy keep a clean static first paint and do not load the marketing motion system.

## Design

The package implements a calm enterprise dark-tech system with one accent, content-owned copy, token-owned values, and composition-only pages. Sans-serif carries prose; monospace is reserved for terminal/proof artifacts. Layouts remain mobile-first and every motion path yields under `prefers-reduced-motion`.

Current visual details and proof content are source-owned by `src/content/site.ts`, components, and token files rather than duplicated as a prose inventory here. System-wide landing behavior and requirements remain in [Architecture Internals](../documentation/lanes/architecture-internals.md#landing-implementation) and the [Landing SDD domain](../sdd/spec/landing.md).

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

## Canonical references

- [Architecture Internals — Landing implementation](../documentation/lanes/architecture-internals.md#landing-implementation)
- [API Reference — Public Landing](../documentation/lanes/api-reference.md#public-landing)
- [Security](../documentation/lanes/security.md)
- [Landing requirements](../sdd/spec/landing.md)
- [Documentation router](../documentation/README.md)
