# No Local Builds, Tests, or Lint

This container has 1 vCPU. Running CPU-intensive commands locally will crash the session.

## Forbidden commands (unless user explicitly overrides)

Never run any of these locally:

- `vitest`, `npm test`, `npm run test`, `npx vitest`
- `npm run build`, `npm run dev`, `npx wrangler dev`
- `npx tsc`, `npm run typecheck`
- `npm run lint`, `npx oxlint`, `npx eslint`
- Any other test runner, bundler, compiler, or dev server

## What to do instead

- Use GitHub Actions CI to run tests, builds, linting, and type checking.
- To verify changes, push to the branch and check CI results with `gh run list` and `gh run view`.
- Use the **code-reviewer** agent to catch issues before pushing (static analysis, no compilation).
- If you need to check syntax or logic, read the code — do not compile it.
- Auto-formatting tools (prettier, gofmt, etc.) also should NOT run locally — they are CPU-intensive on large codebases.

## Override procedure

If the user explicitly asks to run one of these commands locally:

1. Warn them: "This project has a rule against running builds/tests locally because the container only has 1 vCPU and it will likely freeze the session. Are you sure you want to run this locally?"
2. Only proceed if the user confirms after seeing the warning.
