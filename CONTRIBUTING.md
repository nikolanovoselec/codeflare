# Contributing to Codeflare

This guide owns contributor setup, development practice, behavioral verification, and pull-request expectations. Product setup belongs to [README](README.md); exact workflow behavior belongs to [CI/CD](documentation/lanes/ci-cd.md).

## License

Codeflare is licensed under [PolyForm Noncommercial 1.0.0](LICENSE). By submitting a contribution, you agree that your work will be distributed under the same license. Commercial use, resale, or paid hosted offerings require a separate written license from the maintainer.

## Getting Started

1. **Fork** this repository on GitHub.
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/<your-username>/codeflare.git
   cd codeflare
   ```
3. **Install dependencies** for each package you will change or verify:
   ```bash
   npm install
   (cd web-ui && npm install)
   (cd host && npm install)
   (cd landing && npm install)
   (cd openvscode/agent-sidebar && npm install)
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
| `stress/` | k6 load test suites | JavaScript, k6 |
| `preseed/tutorials/` | Tutorial content seeded into new workspaces | Markdown |
| `scripts/` | Build and maintenance utilities | Node.js |
| `.github/workflows/` | CI/CD pipelines | GitHub Actions |

For a full architecture overview, see [documentation/lanes/architecture.md](documentation/lanes/architecture.md).

## Development

```bash
npm run dev                        # Run backend locally (requires wrangler)
cd web-ui && npm run dev           # Frontend dev server (Vite)
```

## Running Tests

Codeflare has package-specific behavioral suites. Run the suites affected by your change; GitHub Actions is the authoritative full verification environment:

```bash
# Backend unit tests (Vitest + @cloudflare/vitest-pool-workers)
npm test

# Frontend unit tests (Vitest + jsdom + SolidJS Testing Library)
cd web-ui && npm test

# Host unit tests (Node.js test runner)
cd host && npm test

# Landing behavior (Vitest)
cd landing && npm test

# Browser IDE extension behavior (Vitest)
cd openvscode/agent-sidebar && npm test
```

### Rate Limit Tests

If you add or modify API endpoints that should be rate-limited, run:

```bash
npm test -- src/__tests__/routes/rate-limits.test.ts
```

See `src/middleware/rate-limit.ts` for the implementation and [Stress Testing](documentation/lanes/stress-test.md) for load-test safety and execution.

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
- **Behavioral tests** assert observable contracts. Backend, frontend, landing, and Browser IDE packages use Vitest; host uses Node's test runner.
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
2. For behavior changes, update the owning REQ and write a failing behavioral test before implementation; keep changed `@impl` and `@test` anchors truthful.
3. Make the smallest implementation and documentation change that satisfies the acceptance criteria.
4. Run affected tests, lint, and type checks where your environment supports them; GitHub Actions remains authoritative.
5. Open a pull request against `develop` with a clear description, verification evidence, and REQ backlinks where applicable.
6. Required checks classify the diff and run the affected lint, type, test, security, dependency, workflow, and package lanes against the exact PR head.

### What Makes a Good PR

- **Focused scope** -- one logical change per PR.
- **Tests included** -- especially for bug fixes (prove the bug existed, prove it is fixed).
- **No unrelated changes** -- avoid drive-by refactors or formatting cleanups.
- **Clear description** -- explain *what* changed and *why*.

## Security

If you discover a security vulnerability, **do not open a public issue**. Report it via [GitHub's private vulnerability reporting](https://github.com/nikolanovoselec/codeflare/security/advisories/new). See [SECURITY.md](SECURITY.md) for details.

An automated penetration test runs weekly against production (`pentest.yml`). If you make changes to authentication, CORS, security headers, or routing, you can trigger it manually from `Actions` > `Pentest` > `Run workflow` to verify nothing regressed. See [Penetration Testing](documentation/lanes/pentest.md) for the current probe contract and dated evidence.

**Deployment secrets and non-default configuration.** Real secrets, non-default deployment variables, and token scopes do not belong in this repository — they live in the private [codeflare-private](https://github.com/nikolanovoselec/codeflare-private) repo. Never commit them here (code, `sdd/`, or `documentation/`); read or change them in that repo. See the [public/private documentation boundary](documentation/README.md#publicprivate-documentation-boundary).

## Questions

Open an issue for questions about the codebase, architecture, or contribution process.

**Related Documentation:**
- [Documentation](documentation/README.md) - Full technical reference
- [README.md](README.md) - Product overview and setup
- [Stress Testing](documentation/lanes/stress-test.md) - Load-test safety and execution
