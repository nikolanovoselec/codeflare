---
name: safe-local-checks
description: Run bounded read-only local lint or syntax checks without replacing CI.
---

# Safe local checks

Use this skill only when a local static or syntax check would give useful feedback. Builds, tests, type checks, dependency-graph analysis, installs, servers, and watch processes remain CI-only.

## Managed runner

Run the seeded wrapper from the repository being checked. The selected analyzer must already be installed by that repository in `node_modules/.bin`; if it is absent, do not install it locally—report that the check is unavailable and rely on CI. Syntax mode needs no repository dependency.

```bash
node ~/.claude/skills/safe-local-checks/scripts/safe-local-check.mjs oxlint [paths...]
node ~/.claude/skills/safe-local-checks/scripts/safe-local-check.mjs eslint [paths...]
node ~/.claude/skills/safe-local-checks/scripts/safe-local-check.mjs biome check [paths...]
node ~/.claude/skills/safe-local-checks/scripts/safe-local-check.mjs prettier --check [paths...]
node ~/.claude/skills/safe-local-checks/scripts/safe-local-check.mjs syntax <file...>
```

The wrapper:

- permits full-project checks and imposes no file-count limit;
- resolves analyzers only from the repository's existing `node_modules/.bin` tree;
- runs at low priority and stops the complete process group after at most three minutes;
- rejects mutation, watch, output-file, and analyzer-concurrency flags;
- never installs or downloads a package.

Biome is limited to `check`. Prettier requires `--check`. Syntax mode runs Node's parser against each named file within one shared deadline.

## Verification boundary

Treat output as supplemental preflight evidence only. It never proves TDD RED or GREEN and never replaces behavioral tests, type checks, Knip, builds, or required CI. Report exactly what ran and reserve final verification claims for CI.

Invoke the wrapper as a standalone command (optionally after one `cd`); shell composition and redirection are blocked. Direct analyzer commands remain blocked so the resource envelope cannot be skipped. The user-created, consume-on-use `/tmp/local-build-bypass` remains the only exceptional route; never create it yourself.
