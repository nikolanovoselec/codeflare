import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, chmodSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire, findPackageJSON } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

const script = fileURLToPath(new URL('../../scripts/verify-pi-lockstep.mjs', import.meta.url));
const jiti = createRequire(import.meta.url).resolve('jiti');

function exercise({ invalidate = false, native = false, quiet = false, dependency = false, nativeDependency = false, unimportedDependency = false, cwd = 'outside', unrelated = false, diagnosticRun = -1, diagnosticStream = 'stderr', warning = false, failure = '' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'jiti-reuse-'));
  try {
    const source = join(directory, native ? 'extension.js' : 'extension.ts');
    const cache = join(directory, 'jiti');
    const count = join(directory, 'count');
    writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
    const dependencyPath = join(directory, nativeDependency ? 'dependency.mjs' : 'dependency.ts');
    writeFileSync(dependencyPath, nativeDependency ? 'export const value = 1;' : 'export const value: number = 1;');
    const factoryFailure = failure === 'module'
      ? 'throw new Error("module fixture failure");'
      : `export default ${failure === 'async' ? 'async ' : ''}function () { throw new Error("factory fixture failure"); }`;
    writeFileSync(source, failure ? factoryFailure : nativeDependency && !unimportedDependency ? "export { value } from './dependency.mjs';" : dependency ? "export { value } from './dependency.ts';" : native ? 'export const value = 1;' : 'export const value: number = 1;');
    mkdirSync(cache);
    mkdirSync(join(directory, 'unrelated'));
    const sibling = join(directory, 'unrelated', native ? 'extension.js' : 'extension.ts');
    writeFileSync(sibling, native ? 'export const value = 1;' : 'export const value: number = 1;');
    const pi = join(directory, 'fixture-pi.cjs');
    writeFileSync(pi, `#!/usr/bin/env node
const fs = require('node:fs');
const countPath = ${JSON.stringify(count)};
const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, 'utf8')) : 0;
fs.writeFileSync(countPath, String(count + 1));
if (count === ${diagnosticRun} || ${warning}) {
  process[${JSON.stringify(diagnosticStream)}].write(${JSON.stringify(warning ? 'Warning: Extension package fixture: harmless warning\nnoise: Failed to load extension is only quoted here\n' : '\u001b[31mError: Failed to load extension "fixture": Failed to load extension: fixture rejection\u001b[0m\n')});
}
if (${invalidate} && count === 1) fs.writeFileSync(${JSON.stringify(dependency ? dependencyPath : source)}, 'export const value: number = 2;');
const { createJiti } = require(${JSON.stringify(jiti)});
const loader = createJiti(__filename, { moduleCache: false, fsCache: ${JSON.stringify(cache)}, ${quiet ? 'debug: false,' : ''} alias: {} });
loader.import(${unrelated} && count === 1 ? ${JSON.stringify(sibling)} : ${JSON.stringify(source)}).then(async module => {
  if (${Boolean(failure)}) await module.default();
  if (module.value !== (${invalidate} && count === 1 ? 2 : 1)) throw new Error('incorrect compiled value');
  if (${unrelated} && count === 0) await loader.import(${JSON.stringify(sibling)});
}).catch(error => {
  if (${Boolean(failure)}) console.error('Error: Failed to load extension "' + ${JSON.stringify(source)} + '": Failed to load extension: ' + error.message);
  else { console.error(error); process.exitCode = 1; }
});
`);
    chmodSync(pi, 0o755);
    const result = spawnSync(process.execPath, [script, '--warm-jiti-entrypoints', pi, cache, source, ...(nativeDependency ? ['--dependencies', dependencyPath] : [])], {
      encoding: 'utf8', timeout: 30_000,
      cwd: cwd === 'inside' ? directory : cwd === 'root' ? '/' : process.cwd(),
    });
    return { ...result, launches: Number(readFileSync(count, 'utf8')) };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

// Native Pi is provisioned by host CI. The safe local wrapper also sets CI=1,
// so use the same GitHub-only gate as the public-SDK transcript tests.
it('REQ-AGENT-234 AC2: real Pi warming preserves an eligible transcript without staging maintenance', {
  skip: process.env.GITHUB_ACTIONS !== 'true',
}, () => {
  const manifestPath = findPackageJSON('@earendil-works/pi-coding-agent', new URL('../../preseed/agents/pi/package.json', import.meta.url));
  assert.ok(manifestPath, 'CI must provision the pinned preseed Pi, not a global substitute');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const selected = JSON.parse(readFileSync(new URL('../../preseed/agents/pi/package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, selected.dependencies['@earendil-works/pi-coding-agent']);
  const sdkEntry = new URL(manifest.exports['.'].import, pathToFileURL(manifestPath)).href;
  const piBinary = join(dirname(manifestPath), manifest.bin.pi);
  const directory = mkdtempSync(join(tmpdir(), 'jiti-transcript-preservation-'));
  try {
    const home = join(directory, 'home');
    const cwd = join(home, 'workspace');
    const agentDir = join(home, '.pi', 'agent');
    const sessions = join(agentDir, 'sessions');
    const temp = join(directory, 'tmp');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(temp);
    // No inherited credentials, session paths, package configuration or caches.
    const env = {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home,
      PI_CODING_AGENT_DIR: agentDir, TMPDIR: temp,
      PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
    };
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: [] }));
    // Build a real v3 main session via public SDK appends, in Pi's normal session
    // location. Sixty completed turns exceed both the 50 MB admission threshold
    // and twenty-prompt cadence; 1 MB records allow a 15–25 MB suffix cut.
    const fixture = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      const { SessionManager } = await import(${JSON.stringify(sdkEntry)});
      const manager = SessionManager.create(process.cwd());
      for (let i = 0; i < 60; i++) {
        manager.appendMessage({ role: 'user', content: 'Synthetic real prompt ' + i, timestamp: Date.now() });
        manager.appendMessage({ role: 'assistant', api: 'anthropic-messages', provider: 'anthropic', model: 'fixture',
          content: [{ type: 'text', text: 'x'.repeat(1_000_000) }], stopReason: 'stop', timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
      }
      const reopened = SessionManager.continueRecent(process.cwd());
      assert.equal(reopened.getSessionFile(), manager.getSessionFile());
      assert.equal(reopened.getHeader().version, 3);
      assert.equal(reopened.getHeader().parentSession, undefined);
      assert.equal(reopened.getBranch().length, 120);
      assert.equal(reopened.getLeafId(), manager.getLeafId());
      process.stdout.write(JSON.stringify({ file: manager.getSessionFile() }));
    `], { cwd, env, encoding: 'utf8' });
    assert.ifError(fixture.error);
    assert.equal(fixture.status, 0, fixture.stderr);
    const { file } = JSON.parse(fixture.stdout);
    assert.ok(file.startsWith(sessions + '/'), 'fixture must be discoverable in the isolated Pi HOME');
    const snapshot = () => {
      const stat = statSync(file);
      const directoryStat = statSync(dirname(file));
      return {
        sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
        size: stat.size, inode: stat.ino, device: stat.dev, mode: stat.mode,
        mtime: stat.mtimeMs, ctime: stat.ctimeMs,
        // Detect even temporary adjacent staging that was subsequently removed.
        directoryMtime: directoryStat.mtimeMs, directoryCtime: directoryStat.ctimeMs,
        entries: readdirSync(sessions, { recursive: true }).sort(),
      };
    };
    const before = snapshot();
    assert.ok(before.size > 50_000_000, 'transcript must be size-eligible for maintenance');
    const extension = fileURLToPath(new URL('../../preseed/agents/pi/extensions/memory-vault.ts', import.meta.url));
    const helper = fileURLToPath(new URL('../../preseed/agents/pi/extensions/transcript-trim/engine.mjs', import.meta.url));
    // Use the production CLI and owner extension, not an argv-recording stand-in.
    // Success also requires cold-warm/replay cache evidence for the owner and its
    // native maintenance helper through the real public warming command.
    const warmed = spawnSync(process.execPath, [script, '--warm-jiti-entrypoints', piBinary,
      join(temp, 'jiti'), extension, '--dependencies', helper], {
      cwd, env, encoding: 'utf8',
    });
    assert.ifError(warmed.error);
    assert.equal(warmed.status, 0, `${warmed.stderr}\n${warmed.stdout}`);
    assert.deepEqual(snapshot(), before, 'warming must not rewrite, replace, append to or stage maintenance beside the transcript');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

describe('REQ-AGENT-210: image extension cache reuse', () => {
  it('qualifies a native helper through its importing extension without registering another factory', () => {
    const result = exercise({ nativeDependency: true });
    assert.equal(result.status, 0, result.stderr);
  });

  it('rejects an advertised native dependency that the extension never imports', () => {
    const result = exercise({ nativeDependency: true, unimportedDependency: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /native import missing/);
  });
  it('proves a real JITI hit in a second fresh process', () => {
    const result = exercise();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.launches, 2);
  });

  for (const cwd of ['root', 'inside', 'outside']) {
    for (const native of [false, true]) {
      it(`accepts exact JITI source evidence with ${cwd} cwd (${native ? 'native JS' : 'TypeScript'})`, () => {
        const result = exercise({ cwd, native });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.launches, 2);
      });
    }
  }

  for (const native of [false, true]) {
    it(`rejects unrelated same-basename evidence (${native ? 'native JS' : 'TypeScript'})`, () => {
      const result = exercise({ cwd: 'root', unrelated: true, native });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /JITI cache reuse not proven/);
      assert.match(result.stderr, /replay cwd="\/", cacheHits=\d+, nativeImports=\d+/);
    });
  }

  for (const failure of ['sync', 'async', 'module']) {
    for (const native of [false, true]) {
      it(`rejects a zero-exit ${failure} load failure after real ${native ? 'native JS' : 'JITI TS'} evaluation`, () => {
        const result = exercise({ failure, native });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Pi JITI extension loading failed: Error: Failed to load extension/);
        assert.match(result.stderr, failure === 'module' ? /module fixture failure/ : /factory fixture failure/);
      });
    }
  }

  for (const diagnosticRun of [0, 1]) {
    for (const diagnosticStream of ['stdout', 'stderr']) {
      for (const native of [false, true]) {
        it(`rejects Pi's zero-exit loader diagnostic in run ${diagnosticRun + 1} on ${diagnosticStream} (${native ? 'JS' : 'TS'})`, () => {
          const result = exercise({ diagnosticRun, diagnosticStream, native });
          assert.notEqual(result.status, 0);
          assert.match(result.stderr, /Pi JITI extension loading failed: Error: Failed to load extension "fixture"/);
        });
      }
    }
  }

  it('accepts unrelated warnings and diagnostic-like noise in both runs', () => {
    const result = exercise({ warning: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.launches, 2);
  });

  it('rejects a source change that produces a cold miss instead of a hit', () => {
    const result = exercise({ invalidate: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /JITI cache reuse not proven/);
  });

  it('rejects a cold dependency even when its entrypoint hits the cache', () => {
    const result = exercise({ dependency: true, invalidate: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /JITI cache reuse not proven:.*dependency\.ts/);
  });

  it('fails closed when a populated cache has no hit evidence', () => {
    const result = exercise({ quiet: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /JITI cache reuse not proven/);
  });

  it('warms native JavaScript without requiring a nonexistent JITI artifact', () => {
    const result = exercise({ native: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.launches, 2);
  });
});
