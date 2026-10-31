---
name: safe-local-checks
description: Run bounded local lint, parse, focused Node test, and package-consistency checks without replacing CI.
---

# Safe local checks

Use this skill only when a bounded local static, syntax, or explicit Node test-file check would give useful feedback. Builds, package test scripts, type checks, dependency-graph analysis, installs, servers, and watch processes remain CI-only.

## When it is useful

- After editing JavaScript modules, run `syntax` to catch parser errors quickly.
- After editing TypeScript or TSX, run `ts-syntax` on the touched files using existing repository-local or image-baked `esbuild`.
- After editing JSON, YAML, shell scripts, package locks, or Pi preseed files, run the matching parse or consistency mode.
- Run explicit Node unit-test files when focused behavioral feedback is needed.
- Run an existing repository-local analyzer, or its approved image-baked copy when no local copy exists, on changed paths or its full-project read-only scope before pushing when lint feedback would help.
- Do not use this capability for package test scripts, broad integration tests, builds, type checks, Knip, final verification, or dependency installs; those belong to CI.

## Managed runner

Run the seeded wrapper from the repository being checked. Analyzer resolution prefers the nearest existing `node_modules/.bin` copy, searching upward only through that repository's root. If no local analyzer exists, the wrapper checks only its fixed image path: `/opt/codeflare/oxlint/node_modules/.bin/{oxlint,eslint,biome,prettier}`. Compatible updated images preinstall all four supported analyzers and both parser libraries (`yaml` and `esbuild`), so checks also work in repositories with no dependencies. Older or incompatible images may lack a required tool; the wrapper fails closed rather than installing it on demand. If neither a local nor an approved image analyzer is available, report the check as unavailable and rely on CI—never install it locally. The wrapper does not search arbitrary ancestors or `PATH`, accept environment-configured tool roots, or download packages.

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
node ~/.claude/skills/safe-local-checks/scripts/safe-local-check.mjs node-test <file...>
node ~/.claude/skills/safe-local-checks/scripts/safe-local-check.mjs lock-consistency [package-lock.json...]
node ~/.claude/skills/safe-local-checks/scripts/safe-local-check.mjs pi-preseed
```

Pi path equivalent:

```bash
node ~/.pi/agent/skills/safe-local-checks/scripts/safe-local-check.mjs <mode> [...]
```

## Modes

- `syntax`: runs Node `--check` for JavaScript/module files.
- `ts-syntax`: parses JS/TS/JSX/TSX with repository-local `esbuild` when present, otherwise the exact image-baked parser; no type checking and no output files.
- `json`: parses repository JSON files.
- `yaml`: parses repository YAML with repository-local `yaml` first, otherwise the approved image-baked copy.
- `shell-syntax`: runs `bash -n` on repository shell files.
- `node-test`: runs only the explicitly named repository test files with Node's test runner.
- `lock-consistency`: checks npm lockfile root dependency mirrors, exact pinned entries, tarball URL/version shape, and SHA-512 integrity. Defaults to `package-lock.json`.
- `pi-preseed`: checks Codeflare Pi preseed package lock consistency, `entrypoint.sh` required package specs, and generated seed embedding.
- `oxlint`, `eslint`, `biome check`, `prettier --check`: run existing analyzers through the bounded wrapper, preferring repository-local copies; each supported analyzer has the fixed image fallback described above when installed.

Examples:

```bash
node ~/.claude/skills/safe-local-checks/scripts/safe-local-check.mjs shell-syntax entrypoint.sh
node ~/.claude/skills/safe-local-checks/scripts/safe-local-check.mjs node-test host/__tests__/npm-platform-pruning.test.js
node ~/.claude/skills/safe-local-checks/scripts/safe-local-check.mjs json package.json preseed/agents/pi/package.json
node ~/.claude/skills/safe-local-checks/scripts/safe-local-check.mjs lock-consistency package-lock.json preseed/agents/pi/package-lock.json
node ~/.claude/skills/safe-local-checks/scripts/safe-local-check.mjs pi-preseed
node ~/.claude/skills/safe-local-checks/scripts/safe-local-check.mjs ts-syntax scripts/patch-pi-goal-review-control.mjs host/__tests__/safe-local-check.test.js
```

## Safety envelope

The wrapper:

- permits full-project checks and imposes no file-count limit;
- resolves analyzers only from the repository's existing `node_modules/.bin` tree, then the supported analyzer's fixed image path when no local copy is installed;
- runs external analyzers at low priority and stops the complete process group after at most three minutes;
- rejects mutation, watch, output-file, cache-writing, and analyzer-concurrency flags;
- rejects repository-file modes that target paths outside the repository;
- runs Node tests only from explicit canonical repository file paths;
- never installs or downloads a package.

Biome is limited to `check`. Prettier requires `--check`. Syntax mode runs Node's parser against each named file within one shared deadline. `ts-syntax` and `yaml` use repository-local `esbuild` and `yaml`, respectively, first, then resolve only those parser libraries within the fixed image roots: `/opt/codeflare/npm-tools/node_modules` for esbuild and `/opt/codeflare/oxlint/node_modules` for YAML. No arbitrary package names or module roots are accepted. Both fail closed when neither approved parser copy is available.

## Verification boundary

Treat output as supplemental preflight evidence only. Focused Node test results provide local behavioral evidence but never replace broader required CI, type checks, Knip, or builds. Report exactly what ran and reserve final verification claims for CI.

Invoke the wrapper as a standalone command (optionally after one `cd`); shell composition and redirection are blocked. Direct analyzer commands remain blocked so the resource envelope cannot be skipped. The user-created, consume-on-use `/tmp/local-build-bypass` remains the only exceptional route; never create it yourself.
