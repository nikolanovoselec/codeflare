// Run only in the final image build, with network access disabled.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createPiWebServices } from '/app/host/dist/pi-web-services.js';

const runtimeCache = process.env.NODE_COMPILE_CACHE;
assert.ok(runtimeCache, 'the image must configure its runtime Node compile cache');
const scratch = mkdtempSync('/tmp/codeflare-pi-web-warm-');
const cache = join(scratch, 'cache');
const home = join(scratch, 'home');
const cwd = join(home, 'workspace');
const runtimeDir = join(scratch, 'run');

async function measureStartup(observeBuildStderr) {
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const services = createPiWebServices({ cwd, runtimeDir, profileRestored: () => true, observeBuildStderr });
  try {
    const start = performance.now();
    await services.start();
    const elapsed = performance.now() - start;
    const health = await services.request('/api/sessiond/health');
    assert.equal(health.ok, true);
    assert.equal(health.activeSessions, 0, 'image prewarm must not open a conversation');
    return Math.round(elapsed);
  } finally {
    // Stock launchers handle SIGTERM; Node flushes its cache on orderly exit.
    await services.close();
    rmSync(runtimeDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

async function verifyBakedCache() {
  const entrypoints = new Map([
    ['pi-web-server.sh', '/dist/server/index.js'],
    ['pi-web-sessiond.sh', '/dist/server/sessiond.js'],
  ]);
  const accepted = new Set();
  Object.assign(process.env, {
    NODE_COMPILE_CACHE: runtimeCache,
    NODE_COMPILE_CACHE_READONLY: '1',
    NODE_DEBUG_NATIVE: 'COMPILE_CACHE',
  });
  const elapsed = await measureStartup((launcher, stderr) => {
    const entry = entrypoints.get(launcher);
    createInterface({ input: stderr }).on('line', line => {
      if (entry && line.startsWith('[compile cache] V8 code cache for ')
        && line.includes(`/node_modules/@jmfederico/pi-web${entry} was accepted,`)) accepted.add(launcher);
    });
  });
  for (const launcher of entrypoints.keys()) {
    assert.ok(accepted.has(launcher), `${launcher} did not accept its entrypoint from the read-only image cache`);
  }
  return elapsed;
}

async function bakeCompileCache() {
  mkdirSync(cache, { mode: 0o700 });
  Object.assign(process.env, { HOME: home, NODE_COMPILE_CACHE: cache, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' });
  const emptyCacheMs = await measureStartup();
  const bakedEntries = readdirSync(cache, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).length;
  assert.ok(bakedEntries > 0, 'stock services must produce reusable Node compile-cache entries');
  mkdirSync(runtimeCache, { recursive: true, mode: 0o700 });
  cpSync(cache, runtimeCache, { recursive: true });
  const populatedCacheMs = await verifyBakedCache();
  console.log(JSON.stringify({ result: 'PI_WEB_COMPILE_CACHE_WARMED', bakedEntries, emptyCacheMs, populatedCacheMs }));
}

try {
  await bakeCompileCache();
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
