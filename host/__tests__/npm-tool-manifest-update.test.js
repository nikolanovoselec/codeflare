import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

import { updatePiRuntimeArtifacts } from '../../scripts/update-pi-runtime-artifacts.mjs';

const script = fileURLToPath(new URL('../../scripts/update-npm-tool-manifests.mjs', import.meta.url));
const piPackage = '@earendil-works/pi-coding-agent';
const piLibraries = ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-tui'];

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('REQ-OPS-033: lock-backed npm bump manifest updates', () => {
  it('updates an exact direct pin and rejects current-version drift', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeflare-npm-tool-pin-'));
    try {
      const manifest = join(directory, 'package.json');
      writeJson(manifest, { dependencies: { bun: '1.0.0' } });

      const updated = spawnSync(process.execPath, [script, manifest, 'bun', '1.0.0', '1.1.0'], { encoding: 'utf8' });
      assert.equal(updated.status, 0, updated.stderr);
      assert.equal(readJson(manifest).dependencies.bun, '1.1.0');

      const drift = spawnSync(process.execPath, [script, manifest, 'bun', '1.0.0', '1.2.0'], { encoding: 'utf8' });
      assert.notEqual(drift.status, 0);
      assert.match(drift.stderr, /expected bun 1\.0\.0, found 1\.1\.0/);
      assert.equal(readJson(manifest).dependencies.bun, '1.1.0');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('REQ-OPS-025 AC4: updates every Pi runtime and prewarm artifact through one fail-closed operation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeflare-pi-pin-'));
    try {
      const toolsDirectory = join(directory, 'preseed/npm-tools');
      const prewarmDirectory = join(directory, 'preseed/agents/pi');
      const scriptsDirectory = join(directory, 'scripts');
      const sourceDirectory = join(directory, 'src/lib');
      const binDirectory = join(directory, 'bin');
      for (const path of [toolsDirectory, prewarmDirectory, scriptsDirectory, sourceDirectory, binDirectory]) {
        mkdirSync(path, { recursive: true });
      }
      const tools = join(toolsDirectory, 'package.json');
      const prewarm = join(prewarmDirectory, 'package.json');
      const toolsLock = join(toolsDirectory, 'package-lock.json');
      const prewarmLock = join(prewarmDirectory, 'package-lock.json');
      const seed = join(sourceDirectory, 'agent-seed.generated.ts');
      const devDependencies = Object.fromEntries(piLibraries.map((dependency) => [dependency, '0.81.0']));
      writeJson(tools, { dependencies: { [piPackage]: '0.81.0' }, devDependencies });
      writeJson(prewarm, {
        dependencies: { [piPackage]: '0.81.0' },
        overrides: { [piPackage]: '0.81.0' },
        devDependencies,
      });

      const fakeNpm = join(binDirectory, 'npm');
      writeFileSync(fakeNpm, `#!/bin/sh\nset -eu\ncase "$*" in\n  "ci --no-audit --no-fund --silent") : ;;\n  "run generate:agent-seed") printf 'export const generated = true;\\n' > src/lib/agent-seed.generated.ts ;;\n  *) exit 64 ;;\nesac\n`);
      chmodSync(fakeNpm, 0o755);
      writeFileSync(join(scriptsDirectory, 'apply-npm-security-lock-pins.mjs'), `import { readFileSync, writeFileSync } from 'node:fs';\nconst path = process.argv[2];\nconst lock = JSON.parse(readFileSync(path, 'utf8'));\nwriteFileSync(path, JSON.stringify({ ...lock, securityPinned: true }) + '\\n');\n`);
      writeFileSync(join(scriptsDirectory, 'regenerate-npm-package-lock.mjs'), `import { writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst directory = process.argv[2];\nconst generated = directory.endsWith('/npm-tools') ? 'tools' : 'prewarm';\nwriteFileSync(join(directory, 'package-lock.json'), JSON.stringify({ generated, securityPinned: true }) + '\\n');\n`);

      updatePiRuntimeArtifacts(directory, '0.81.0', '0.82.0', { npmCommand: fakeNpm });

      const nextTools = readJson(tools);
      const nextPrewarm = readJson(prewarm);
      assert.equal(nextTools.dependencies[piPackage], '0.82.0');
      assert.equal(nextPrewarm.dependencies[piPackage], '0.82.0');
      assert.equal(nextPrewarm.overrides[piPackage], '0.82.0');
      for (const dependency of piLibraries) {
        assert.equal(nextTools.devDependencies[dependency], '0.82.0');
        assert.equal(nextPrewarm.devDependencies[dependency], '0.82.0');
      }
      assert.deepEqual(readJson(toolsLock), { generated: 'tools', securityPinned: true });
      assert.deepEqual(readJson(prewarmLock), { generated: 'prewarm', securityPinned: true });
      assert.equal(readFileSync(seed, 'utf8'), 'export const generated = true;\n');

      writeFileSync(fakeNpm, '#!/bin/sh\nexit 9\n');
      assert.throws(
        () => updatePiRuntimeArtifacts(directory, '0.82.0', '0.83.0', { npmCommand: fakeNpm }),
        /exited 9/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
