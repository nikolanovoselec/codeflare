import { describe, expect, it } from 'vitest';
import { LOCAL_BUILD_BYPASS, localBuildBlockReason } from '../../../preseed/agents/pi/extensions/guard-helpers';

const noBypass = { existsSync: () => false, unlinkSync: () => {} };

// In-memory filesystem only: these tests never touch the user's real sentinel.
function bypassFs(consumable = true) {
  const files = new Set([LOCAL_BUILD_BYPASS]);
  return {
    files,
    existsSync: (path: string) => files.has(path),
    unlinkSync: (path: string) => {
      if (!consumable) throw new Error('permission denied');
      files.delete(path);
    },
  };
}

describe('REQ-AGENT-052 AC4: Pi local-build guard classifies execution, not staged filenames', () => {
  it.each([
    'git add vitest.node.config.ts sdd/spec/changes.md',
    'git -C /home/user/workspace/codeflare add vitest.node.config.ts sdd/spec/changes.md',
    "cd /home/user/workspace/codeflare && git ls-files 'host/__tests__/*oxlint*' 'host/__tests__/*shadow*' 'host/__tests__/*npm-tool*'",
    'cd /home/user/workspace/codeflare/image/oxlint && npm install --package-lock-only --ignore-scripts --no-audit --no-fund',
    "git show HEAD:image/oxlint/package.json",
    "printf '%s' 'oxlint vitest tsc'",
    "const packages = ['oxlint', 'vitest', 'typescript']; for (const name of packages) { console.log(await (await fetch('https://registry.npmjs.org/' + name + '/latest')).json()); }",
    "const packages = [ 'oxlint', 'vitest', 'tsc' ]; console.log(packages);",
    "const packages = ['@biomejs/biome', 'eslint', 'prettier']; console.log(packages);",
    "cat <<'EOF'\nnpx vitest --run\nEOF",
  ])('allows inert runner names without consuming an override: %s', (command) => {
    const fs = bypassFs();
    expect(localBuildBlockReason(command, noBypass)).toBeUndefined();
    expect(localBuildBlockReason(command, fs)).toBeUndefined();
    expect(fs.files.has(LOCAL_BUILD_BYPASS)).toBe(true);
  });

  it.each([
    'npx vitest --run', 'npm test', 'npm run build', 'pnpm run lint', 'yarn typecheck', 'bun test',
    "git -c 'alias.check=!npm test' check",
    "git -C /repo -calias.check='!npm test' check",
    '/repo/node_modules/.bin/oxlint src',
    'cd /repo/image/oxlint && npx --no-install oxlint .',
    'npx -p vitest vitest --run',
    'npm exec -- vitest --run',
    'npx unknown-wrapper npm test',
    'git add vitest.node.config.ts && npx vitest --run',
    'git ls-files "$(npx vitest --run)"',
    'git add "$(npx vitest --run)"',
    "printf '%s' \"$(npm test)\"",
    "bash -lc 'cd /repo && npm test'",
    "sh -c 'npx -y oxlint@1.66.0 .'",
    "npx --call 'npm test'",
    "npx --call='npm test'",
    'unknown-wrapper npm test',
    'unknown-wrapper --flag npx vitest --run',
    "unknown-wrapper 'npm test'",
    "node -e \"require('node:child_process').execSync('npm test')\"",
    "const { execFileSync } = require('node:child_process'); execFileSync('npx', ['vitest', '--run']);",
    'node --check app.js',
    'npx @biomejs/biome check .',
    'go test ./...', 'swift test', 'cargo test', 'wrangler dev',
  ])('blocks actual direct or nested execution: %s', (command) => {
    expect(localBuildBlockReason(command, noBypass)).toMatch(/Direct local builds\/tests/);
  });

  it.each([
    'node /home/user/.pi/agent/skills/safe-local-checks/scripts/safe-local-check.mjs unknown .',
    'cd /repo && node /home/user/.pi/agent/skills/safe-local-checks/scripts/safe-local-check.mjs syntax app.js',
  ])('delegates standalone managed wrapper validation without consuming an override: %s', (command) => {
    const fs = bypassFs();
    expect(localBuildBlockReason(command, fs)).toBeUndefined();
    expect(fs.files.has(LOCAL_BUILD_BYPASS)).toBe(true);
  });

  it.each([
    'node /home/user/.pi/agent/skills/safe-local-checks/scripts/safe-local-check.mjs syntax app.js; echo done',
    'node /home/user/.pi/agent/skills/safe-local-checks/scripts/safe-local-check.mjs syntax app.js | cat',
    'node /home/user/.pi/agent/skills/safe-local-checks/scripts/safe-local-check.mjs syntax app.js > output',
    'cd /repo; node /home/user/.pi/agent/skills/safe-local-checks/scripts/safe-local-check.mjs unknown .',
  ])('fails closed for unmanaged wrapper composition: %s', (command) => {
    expect(localBuildBlockReason(command, noBypass)).toMatch(/Direct local builds\/tests/);
  });
});

describe('REQ-AGENT-052 AC5: user-only consume-on-use build override', () => {
  it('allows exactly one guarded command after successful consumption', () => {
    const fs = bypassFs();
    expect(localBuildBlockReason('npm test', fs)).toBeUndefined();
    expect(fs.files.has(LOCAL_BUILD_BYPASS)).toBe(false);
    expect(localBuildBlockReason('npm test', fs)).toMatch(/Direct local builds\/tests/);
  });

  it('keeps blocking when the sentinel cannot be consumed', () => {
    const fs = bypassFs(false);
    expect(localBuildBlockReason('npm test', fs)).toContain(LOCAL_BUILD_BYPASS);
    expect(fs.files.has(LOCAL_BUILD_BYPASS)).toBe(true);
    expect(localBuildBlockReason('npm test', fs)).toMatch(/Direct local builds\/tests/);
  });
});
