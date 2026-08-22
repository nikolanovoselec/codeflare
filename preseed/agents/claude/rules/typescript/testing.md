---
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
---
# TypeScript/JavaScript Testing

**Important:** Tests and type checks run via CI only. For supplemental read-only lint or syntax feedback, load `safe-local-checks` and use only its managed wrapper; CI remains authoritative.

## E2E Testing

Use **Playwright** as the E2E testing framework for critical user flows.

