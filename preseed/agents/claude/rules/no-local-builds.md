# No Local Builds, Tests, or Lint

1-vCPU container. CPU-intensive commands locally will crash the session.

**Never run locally** (unless user explicitly overrides):
- Test runners: `vitest`, `npm test`, `pytest`, etc.
- Builds / dev servers: `npm run build`, `npm run dev`, `wrangler dev`
- Type checkers: `tsc`, `npm run typecheck`
- Linters: `eslint`, `oxlint`, `npm run lint`
- Formatters: `prettier`, `gofmt` (on large repos)

**Instead:** push to a branch and verify via CI (`gh run list`, `gh run view`). For pre-push checks invoke the `code-reviewer` agent (static analysis, no compilation). To check syntax/logic, read the code.

**Override:** if user explicitly requests local execution, warn them about the freeze risk and only proceed on confirmation.
