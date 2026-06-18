# No Local Builds, Tests, or Lint

Resource-constrained container. CPU-intensive commands run locally can crash the session.

**Never run locally** (unless user explicitly overrides):
- Test runners: `vitest`, `npm test`, `pytest`, etc.
- Builds / dev servers: `npm run build`, `npm run dev`, `wrangler dev`
- Type checkers: `tsc`, `npm run typecheck`
- Linters: `eslint`, `oxlint`, `npm run lint`
- Formatters: `prettier`, `gofmt` (on large repos)

**Instead:** push to a branch and verify via CI (`gh run list`, `gh run view`). PR-boundary review enforcement starts the required reviewers when a PR to `main`/`master` is opened or updated; do not spawn review agents manually unless the user explicitly asks. To check syntax/logic before that point, read the code.

**Override:** if user explicitly requests local execution, warn them about the freeze risk and only proceed on confirmation.
