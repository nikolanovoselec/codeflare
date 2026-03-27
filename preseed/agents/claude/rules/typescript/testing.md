---
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
---
# TypeScript/JavaScript Testing

**Important:** Tests run via CI only (GitHub Actions). Do not run test suites, linters, or type checkers locally — the container has 1 vCPU. Write tests, push, and verify via `gh run view`.

## E2E Testing

Use **Playwright** as the E2E testing framework for critical user flows.

