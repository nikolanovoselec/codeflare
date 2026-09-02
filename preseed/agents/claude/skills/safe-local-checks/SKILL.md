---
name: safe-local-checks
description: Run bounded read-only local lint, parse, and package-consistency checks without replacing CI.
---

# Safe local checks

Use this skill only when a local static or syntax check would give useful feedback. Builds, tests, type checks, dependency-graph analysis, installs, servers, and watch processes remain CI-only.

## When it is useful

- After editing JavaScript modules, run `syntax` to catch parser errors quickly.
- After editing TypeScript or TSX, run `ts-syntax` on the touched files when repo-local `esbuild` is already installed.
- After editing JSON, YAML, shell scripts, package locks, or Pi preseed files, run the matching parse or consistency mode.
- Run a repository-installed analyzer on changed paths, or its full-project read-only scope, before pushing when lint feedback would help.
- Do not use this capability for unit or integration tests, builds, type checks, Knip, final verification, or dependency installs; those belong to CI.

## Managed runner

Run the seeded wrapper from the repository being checked. The selected analyzer must already be installed by that repository in `node_modules/.bin`; if it is absent, do not install it locally—report that the check is unavailable and rely on CI. Parse and consistency modes never download packages.

```bash
node ~/.claude/skills/safe-local-checks/scripts/safe-local-check.mjs oxlint [paths...]
node ~/.claude/skills/safe-local-checks/scripts/safe-local-check.mjs eslint [paths...]
node ~/.claude/skills/safe-local-checks/scripts/safe-local-check.mjs biome check [paths...]
node ~/.claude/skills/safe-local-checks/scripts/safe-local-check.mjs prettier --check [paths...]
node ~/.claude/skills/safe-local-checks/scripts/safe-local-check.mjs syntax <file...>
node ~/.claude/skills/safe-local-checks/scripts/safe-local-check.mjs ts-syntax <file...>
node ~/.claude/skills/safe-local-checks/scripts/safe-local-check.mjs json <file...>
node ~/.claude/skills/safe-local-checks/scripts/safe-local-check.mjs yaml <file...>
node ~/.claude/skills/safe-local-checks/scripts/safe-local-check.mjs shell-syntax <file...>
node ~/.claude/skills/safe-local-checks/scripts/safe-local-check.mjs lock-consistency [package-lock.json...]
node ~/.claude/skills/safe-local-checks/scripts/safe-local-check.mjs pi-preseed
```

Pi path equivalent:

```bash
node ~/.pi/agent/skills/safe-local-checks/scripts/safe-local-check.mjs <mode> [...]
```

## Modes

- `syntax`: runs Node `--check` for JavaScript/module files.
- `ts-syntax`: parses JS/TS/JSX/TSX with repo-local `esbuild` transform; no type checking and no output files.
- `json`: parses repository JSON files.
- `yaml`: parses repository YAML with repo-local `yaml`.
- `shell-syntax`: runs `bash -n` on repository shell files.
- `lock-consistency`: checks npm lockfile root dependency mirrors, exact pinned entries, tarball URL/version shape, and SHA-512 integrity. Defaults to `package-lock.json`.
- `pi-preseed`: checks Codeflare Pi preseed package lock consistency, `entrypoint.sh` required package specs, and generated seed embedding.
- `oxlint`, `eslint`, `biome check`, `prettier --check`: run existing repo-local analyzers through the bounded wrapper.

Examples:

```bash
node ~/.claude/skills/safe-local-checks/scripts/safe-local-check.mjs shell-syntax entrypoint.sh
node ~/.claude/skills/safe-local-checks/scripts/safe-local-check.mjs json package.json preseed/agents/pi/package.json
node ~/.claude/skills/safe-local-checks/scripts/safe-local-check.mjs lock-consistency package-lock.json preseed/agents/pi/package-lock.json
node ~/.claude/skills/safe-local-checks/scripts/safe-local-check.mjs pi-preseed
node ~/.claude/skills/safe-local-checks/scripts/safe-local-check.mjs ts-syntax scripts/patch-pi-goal-review-control.mjs host/__tests__/safe-local-check.test.js
```

## Safety envelope

The wrapper:

- permits full-project checks and imposes no file-count limit;
- resolves analyzers only from the repository's existing `node_modules/.bin` tree;
- runs external analyzers at low priority and stops the complete process group after at most three minutes;
- rejects mutation, watch, output-file, cache-writing, and analyzer-concurrency flags;
- rejects repository-file modes that target paths outside the repository;
- never installs or downloads a package.

Biome is limited to `check`. Prettier requires `--check`. Syntax mode runs Node's parser against each named file within one shared deadline. `ts-syntax` and `yaml` require existing repository dependencies and fail closed if unavailable.

## Verification boundary

Treat output as supplemental preflight evidence only. It never proves TDD RED or GREEN and never replaces behavioral tests, type checks, Knip, builds, or required CI. Report exactly what ran and reserve final verification claims for CI.

Invoke the wrapper as a standalone command (optionally after one `cd`); shell composition and redirection are blocked. Direct analyzer commands remain blocked so the resource envelope cannot be skipped. The user-created, consume-on-use `/tmp/local-build-bypass` remains the only exceptional route; never create it yourself.
