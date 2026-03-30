# Contributing to Codeflare

Thank you for your interest in contributing to Codeflare. This guide covers everything you need to get started.

## License

Codeflare is licensed under [PolyForm Noncommercial 1.0.0](LICENSE). By submitting a contribution, you agree that your work will be distributed under the same license. Commercial use, resale, or paid hosted offerings require a separate written license from the maintainer.

## Getting Started

1. **Fork** this repository on GitHub.
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/<your-username>/codeflare.git
   cd codeflare
   ```
3. **Install dependencies** (both backend and frontend):
   ```bash
   npm install
   cd web-ui && npm install && cd ..
   ```

## Project Structure

| Directory | Purpose | Technology |
|-----------|---------|------------|
| `src/` | Backend (Cloudflare Worker) | TypeScript, Hono, Zod |
| `src/timekeeper/` | Per-user usage tracking Durable Object | TypeScript |
| `src/container/` | Container lifecycle Durable Object | TypeScript |
| `src/routes/admin/` | Admin-only API routes (tier management) | TypeScript, Hono |
| `web-ui/` | Frontend SPA | SolidJS, xterm.js, Vite |
| `host/` | Container terminal server | Node.js, node-pty |
| `e2e/` | End-to-end tests | Vitest, Puppeteer |
| `e2e/stress/` | k6 load test suites | JavaScript, k6 |
| `preseed/tutorials/` | Tutorial content seeded into new workspaces | Markdown, assets |
| `scripts/` | Build and maintenance utilities | Node.js |
| `.github/workflows/` | CI/CD pipelines | GitHub Actions |

For a full architecture overview, see [TECHNICAL.md](TECHNICAL.md).

## Development

```bash
npm run dev                        # Run backend locally (requires wrangler)
cd web-ui && npm run dev           # Frontend dev server (Vite)
```

## Running Tests

Codeflare has five test layers totaling ~3,000 tests. Run them with:

```bash
# Backend unit tests (Vitest + @cloudflare/vitest-pool-workers)
npm test

# Frontend unit tests (Vitest + jsdom + SolidJS Testing Library)
cd web-ui && npm test

# Host unit tests (Node.js test runner)
cd host && npm test

# E2E API tests (requires a deployed worker + CF Access service tokens)
npm run test:e2e:api

# E2E UI tests (requires a deployed worker + Puppeteer)
npm run test:e2e:ui                # Desktop
npm run test:e2e:ui-mobile         # Mobile
```

### Rate Limit Tests

If you add or modify API endpoints that should be rate-limited, run:

```bash
npm test -- src/__tests__/routes/rate-limits.test.ts
```

See `src/middleware/rate-limit.ts` for the rate limiting implementation and [STRESS_TEST.md](STRESS_TEST.md) for load testing details.

### Subscription and Usage Tests

The subscription system has dedicated test files:

```bash
npm test -- src/__tests__/lib/subscription.test.ts     # Tier resolution, config, session modes
npm test -- src/__tests__/lib/email.test.ts             # Email sending (welcome, subscription, tier change)
npm test -- src/__tests__/routes/auth-subscribe.test.ts # Subscribe endpoint, Turnstile, idempotency
npm test -- src/__tests__/timekeeper/index.test.ts      # Timekeeper DO, usage accumulation, quota enforcement
npm test -- src/__tests__/lib/access-tier.test.ts       # Tier-based access control
npm test -- src/__tests__/lib/kv-keys.test.ts           # Timekeeper KV key generation, date utilities
```

### Linting and Type Checking

```bash
npm run lint                       # Backend (oxlint)
cd web-ui && npm run lint          # Frontend (oxlint)
npm run typecheck                  # Backend (tsc --noEmit)
cd web-ui && npm run typecheck     # Frontend
```

## Code Style

- **TypeScript** with strict mode enabled across all layers.
- **Vitest** for all testing (backend uses `@cloudflare/vitest-pool-workers`, frontend uses jsdom).
- **SolidJS** for the frontend -- not React. Reactivity is signal-based. See `web-ui/src/stores/` for patterns.
- **Hono** as the backend router on Cloudflare Workers.
- **Zod** for input validation on both backend (`src/lib/schemas.ts`) and frontend (`web-ui/src/lib/schemas.ts`).
- **oxlint** for linting. Run `npm run lint` before submitting.
- No Prettier or ESLint -- oxlint handles it.

## Submitting Changes

### Branch Naming

Use descriptive branch names with a prefix:

- `feat/` -- new features
- `fix/` -- bug fixes
- `refactor/` -- code restructuring
- `test/` -- test additions or fixes
- `docs/` -- documentation changes

Example: `fix/websocket-reconnect-race-condition`

### Pull Request Process

1. Create a feature branch from `develop`.
2. Make your changes. Write tests for new functionality.
3. Ensure all tests pass locally (`npm test` and `cd web-ui && npm test` at minimum).
4. Run linting and type checking -- CI will reject PRs that fail these.
5. Open a pull request against `develop` with a clear description of the change and its motivation.
6. CI runs automatically on all PRs: lint, tests, typecheck, security audit, dependency review, and CodeQL analysis.

### What Makes a Good PR

- **Focused scope** -- one logical change per PR.
- **Tests included** -- especially for bug fixes (prove the bug existed, prove it is fixed).
- **No unrelated changes** -- avoid drive-by refactors or formatting cleanups.
- **Clear description** -- explain *what* changed and *why*.

## Security

If you discover a security vulnerability, **do not open a public issue**. Report it via [GitHub's private vulnerability reporting](https://github.com/nikolanovoselec/codeflare/security/advisories/new). See [SECURITY.md](SECURITY.md) for details.

An automated penetration test runs weekly against production (`pentest.yml`). If you make changes to authentication, CORS, security headers, or routing, you can trigger it manually from `Actions` > `Pentest` > `Run workflow` to verify nothing regressed. See [PENTEST.md](PENTEST.md) for a full breakdown of what gets tested.

## Questions

Open an issue for questions about the codebase, architecture, or contribution process.

**Related Documentation:**
- [TECHNICAL.md](TECHNICAL.md) - Full technical reference
- [README.md](README.md) - Product overview and setup
- [STRESS_TEST.md](STRESS_TEST.md) - Load testing guide
