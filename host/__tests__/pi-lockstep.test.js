import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash, getFips } from 'node:crypto';
import { describe, it } from 'node:test';

const script = fileURLToPath(new URL('../../scripts/verify-pi-lockstep.mjs', import.meta.url));

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function resolveCachePath(sourcePath, cacheDirectory) {
  const result = spawnSync(
    process.execPath,
    [script, '--jiti-cache-path', sourcePath, cacheDirectory],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function readArgs(path) {
  return readFileSync(path, 'utf8').trim().split('\n');
}

describe('REQ-AGENT-111 AC3: Goal jiti cache path and fail-closed artifact verification', () => {
  it('rejects a missing @narumitw/pi-goal entrypoint artifact and accepts the expected artifact', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeflare-goal-cache-'));
    try {
      const installedRoot = join(directory, 'installed');
      const runtimeRoot = join(directory, 'runtime');
      const sourceDirectory = join(installedRoot, 'src');
      mkdirSync(sourceDirectory, { recursive: true });
      mkdirSync(runtimeRoot);
      const installedSource = join(sourceDirectory, 'index.ts');
      const runtimeSource = join(runtimeRoot, 'index.ts');
      writeFileSync(installedSource, 'export { default } from "./goal.js";\n');
      symlinkSync(installedSource, runtimeSource);

      const cacheDirectory = join(directory, 'cache');
      const pathResult = spawnSync(process.execPath, [script, '--jiti-cache-path', runtimeSource, cacheDirectory], {
        encoding: 'utf8',
      });
      assert.equal(pathResult.status, 0, pathResult.stderr);
      const realSource = realpathSync(runtimeSource);
      const algorithm = getFips?.() ? 'sha256' : 'md5';
      const hash = createHash(algorithm).update(realSource).digest('hex').slice(0, 8);
      const expectedArtifact = join(cacheDirectory, `src-index.${hash}.mjs`);
      assert.equal(pathResult.stdout, `${expectedArtifact}\n`);

      const missing = spawnSync(process.execPath, [script, '--verify-jiti-cache', runtimeSource, cacheDirectory], {
        encoding: 'utf8',
      });
      assert.notEqual(missing.status, 0);
      assert.equal(missing.stderr, `jiti cache artifact is missing at ${expectedArtifact}\n`);

      mkdirSync(cacheDirectory);
      mkdirSync(expectedArtifact);
      const directoryCollision = spawnSync(
        process.execPath,
        [script, '--verify-jiti-cache', runtimeSource, cacheDirectory],
        { encoding: 'utf8' },
      );
      assert.notEqual(directoryCollision.status, 0);
      assert.equal(directoryCollision.stderr, `jiti cache artifact is missing at ${expectedArtifact}\n`);
      rmSync(expectedArtifact, { recursive: true });

      writeFileSync(expectedArtifact, 'compiled cache\n');
      const present = spawnSync(process.execPath, [script, '--verify-jiti-cache', runtimeSource, cacheDirectory], {
        encoding: 'utf8',
      });
      assert.equal(present.status, 0, present.stderr);
      assert.equal(present.stdout, `${expectedArtifact}\n`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('REQ-AGENT-131: pi-usage JITI warm-cache contract', () => {
  it('warms every requested entrypoint and fails when Usage produces no cache artifact', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeflare-usage-cache-'));
    try {
      const cacheDirectory = join(directory, 'cache');
      const goalSource = join(directory, 'goal/src/index.ts');
      const usageSource = join(directory, 'usage/src/index.ts');
      mkdirSync(join(directory, 'goal/src'), { recursive: true });
      mkdirSync(join(directory, 'usage/src'), { recursive: true });
      writeFileSync(goalSource, 'export default function goal() {}\n');
      writeFileSync(usageSource, 'export default function usage() {}\n');

      const argsLog = join(directory, 'args.log');
      const fakePi = join(directory, 'pi');
      writeFileSync(fakePi, `#!/bin/sh
printf '%s\\n' "$@" > "$ARGS_LOG"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--extension" ]; then
    shift
    artifact="$(node "$VERIFY_SCRIPT" --jiti-cache-path "$1" "$CACHE_DIR")"
    mkdir -p "$(dirname "$artifact")"
    printf 'compiled\\n' > "$artifact"
  fi
  shift
done
`);
      chmodSync(fakePi, 0o755);

      const success = spawnSync(
        process.execPath,
        [script, '--warm-jiti-entrypoints', fakePi, cacheDirectory, goalSource, usageSource],
        {
          encoding: 'utf8',
          env: { ...process.env, ARGS_LOG: argsLog, VERIFY_SCRIPT: script, CACHE_DIR: cacheDirectory },
        },
      );
      assert.equal(success.status, 0, success.stderr);
      assert.deepEqual(success.stdout.trim().split('\n'), [
        resolveCachePath(goalSource, cacheDirectory),
        resolveCachePath(usageSource, cacheDirectory),
      ]);
      assert.deepEqual(
        readArgs(argsLog),
        ['--no-extensions', '--extension', goalSource, '--extension', usageSource, '-p', 'warm'],
      );

      rmSync(cacheDirectory, { recursive: true });
      mkdirSync(cacheDirectory);
      writeFileSync(resolveCachePath(goalSource, cacheDirectory), 'compiled\n');
      const noArtifactPi = join(directory, 'pi-no-artifact');
      writeFileSync(noArtifactPi, '#!/bin/sh\nexit 0\n');
      chmodSync(noArtifactPi, 0o755);
      const missing = spawnSync(
        process.execPath,
        [script, '--warm-jiti-entrypoints', noArtifactPi, cacheDirectory, goalSource, usageSource],
        { encoding: 'utf8' },
      );
      assert.notEqual(missing.status, 0);
      assert.equal(
        missing.stderr,
        `jiti cache artifact is missing at ${resolveCachePath(usageSource, cacheDirectory)}\n`,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('REQ-AGENT-001 AC6: Pi image lockstep fails closed', () => {
  it('accepts matching runtime, prewarm, and installed Pi versions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeflare-pi-lockstep-'));
    try {
      const runtime = join(directory, 'runtime.json');
      const prewarm = join(directory, 'prewarm.json');
      const installed = join(directory, 'installed.json');
      writeJson(runtime, { dependencies: { '@earendil-works/pi-coding-agent': '0.82.0' } });
      writeJson(prewarm, {
        dependencies: { '@earendil-works/pi-coding-agent': '0.82.0' },
        overrides: { '@earendil-works/pi-coding-agent': '0.82.0' },
      });
      writeJson(installed, { version: '0.82.0' });

      const result = spawnSync(process.execPath, [script, runtime, prewarm, installed], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects prewarm dependency, override, and installed version drift independently', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeflare-pi-lockstep-'));
    try {
      const runtime = join(directory, 'runtime.json');
      const prewarm = join(directory, 'prewarm.json');
      const installed = join(directory, 'installed.json');
      writeJson(runtime, { dependencies: { '@earendil-works/pi-coding-agent': '0.82.0' } });
      writeJson(prewarm, {
        dependencies: { '@earendil-works/pi-coding-agent': '0.81.0' },
        overrides: { '@earendil-works/pi-coding-agent': '0.82.0' },
      });
      writeJson(installed, { version: '0.82.0' });

      const dependencyDrift = spawnSync(process.execPath, [script, runtime, prewarm], { encoding: 'utf8' });
      assert.notEqual(dependencyDrift.status, 0);
      assert.match(dependencyDrift.stderr, /prewarm Pi SDK dependency 0\.81\.0 != runtime 0\.82\.0/);

      writeJson(prewarm, {
        dependencies: { '@earendil-works/pi-coding-agent': '0.82.0' },
        overrides: { '@earendil-works/pi-coding-agent': '0.81.0' },
      });
      const overrideDrift = spawnSync(process.execPath, [script, runtime, prewarm], { encoding: 'utf8' });
      assert.notEqual(overrideDrift.status, 0);
      assert.match(overrideDrift.stderr, /prewarm Pi SDK override 0\.81\.0 != runtime 0\.82\.0/);

      writeJson(prewarm, {
        dependencies: { '@earendil-works/pi-coding-agent': '0.82.0' },
        overrides: { '@earendil-works/pi-coding-agent': '0.82.0' },
      });
      writeJson(installed, { version: '0.81.0' });
      const installedDrift = spawnSync(process.execPath, [script, runtime, prewarm, installed], { encoding: 'utf8' });
      assert.notEqual(installedDrift.status, 0);
      assert.match(installedDrift.stderr, /installed prewarm Pi SDK 0\.81\.0 != runtime 0\.82\.0/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
