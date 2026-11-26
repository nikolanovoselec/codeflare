// Disposable Linux runner only. Use an already pulled production image by digest, not a rebuilt fixture:
//   IMAGE='registry/repository@sha256:<platform-manifest-digest>' # set to the approved image
//   docker image inspect "$IMAGE" --format '{{.Id}} {{json .RepoDigests}}'
//   docker run --rm --init --pull=never --network=none --read-only --no-healthcheck \
//     --cap-drop=ALL --security-opt=no-new-privileges \
//     --tmpfs /home/user:rw,mode=0700,size=64m --tmpfs /tmp:rw,mode=1777,size=256m \
//     --mount "type=bind,src=$PWD/scripts/ci/diagnose-pi-web-startup.mjs,dst=/probe.mjs,readonly" \
//     --entrypoint /usr/bin/timeout "$IMAGE" -k 10s 5m /usr/bin/env -i \
//     PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node /probe.mjs
// Do not mount real profiles, caches or credentials. Restarting this container is not a fresh placement.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

const read = path => readFileSync(path, 'utf8');
const json = path => JSON.parse(read(path));
const home = '/home/user'; // Jiti keys include the real extension path used at image build time.
const mounts = read('/proc/self/mountinfo').trim().split('\n').map(line => line.split(' '));
assert.ok(mounts.some(row => row[4] === '/' && row[5].split(',').includes('ro')), 'read-only image required');
for (const path of [home, '/tmp']) {
  assert.ok(mounts.some(row => row[3] === '/' && row[4] === path && row[row.indexOf('-') + 1] === 'tmpfs'
    && row[5].split(',').includes('rw')), `${path} must be a private writable tmpfs`);
}
assert.deepEqual(readdirSync(home), [], 'diagnostic HOME must start empty');
assert.deepEqual(Object.keys(process.env), ['PATH'], 'launch with env -i as shown above');
assert.deepEqual(read('/proc/net/dev').trim().split('\n').slice(2).map(line => line.split(':')[0].trim()), ['lo'],
  'an offline network namespace is required');

const { createPiWebServices, managedPiPackage, PI_WEB_PORT } = await import('/app/host/dist/pi-web-services.js');
const webRoot = '/opt/codeflare/pi-web';
const webName = '@jmfederico/pi-web';
const webVersion = json(join(webRoot, 'node_modules', webName, 'package.json')).version;
const lock = json(join(webRoot, 'package-lock.json')).packages;
assert.equal(webVersion, lock[''].dependencies[webName]);
assert.equal(webVersion, lock[`node_modules/${webName}`].version);
const piVersion = json(join(managedPiPackage(), 'package.json')).version;

const managed = '/opt/codeflare/pi-agent';
const agentDir = join(home, '.pi/agent');
const cwd = join(home, 'workspace');
const bakedNode = '/root/.cache/node-compile-cache';
const bakedJiti = '/opt/codeflare/jiti-cache';
for (const path of [bakedNode, bakedJiti]) assert.ok(readdirSync(path).length, `missing baked cache: ${path}`);
const entrypoint = read('/entrypoint.sh');
const inventoryStart = entrypoint.indexOf('\nconfigure_pi_packages_and_review_inventory() {');
const inventoryEnd = entrypoint.indexOf('\nwarm_pi_npm_dependencies() {', inventoryStart);
assert.ok(inventoryStart >= 0 && inventoryEnd > inventoryStart, 'missing image package inventory');

function restoreSyntheticProfile() {
  cpSync(join(managed, 'extensions'), join(agentDir, 'extensions'), { recursive: true });
  const npm = join(agentDir, 'npm');
  mkdirSync(npm);
  for (const file of ['package.json', 'package-lock.json']) cpSync(join(managed, 'npm', file), join(npm, file));
  symlinkSync(join(managed, 'npm/node_modules'), join(npm, 'node_modules'));
  // Replay only the packaged inventory function, never source /entrypoint.sh.
  execFileSync('/bin/bash', ['-ec', `${entrypoint.slice(inventoryStart, inventoryEnd)}\nconfigure_pi_packages_and_review_inventory`], {
    cwd, env: { ...process.env, USER_HOME: home, SESSION_MODE: 'advanced' }, timeout: 5000,
  });
  assert.ok(json(join(agentDir, 'settings.json')).packages.length > 0);
}

const children = () => read(`/proc/self/task/${process.pid}/children`).trim().split(/\s+/).filter(Boolean).map(Number);
const pids = () => readdirSync('/proc').filter(name => /^\d+$/.test(name)).sort();
const listeners = () => ['tcp', 'tcp6'].flatMap(table => read(`/proc/net/${table}`).trim().split('\n').slice(1).flatMap(row => {
  const [, local, , state] = row.trim().split(/\s+/);
  return state === '0A' ? [local] : [];
}));
const socketBound = path => read('/proc/net/unix').split('\n').some(row => row.endsWith(` ${path}`));
const bootPrefix = '[pi-web] service boot timing ';
const startupLimitMs = 45_000;

async function measure(profile, nodeCache, jitiCache, root) {
  const runtimeDir = join(root, 'run');
  const daemonSocket = join(runtimeDir, 'daemon.sock');
  const nodeDir = join(root, 'node');
  const tmp = join(root, 'tmp');
  const jitiDir = join(tmp, 'jiti');
  mkdirSync(cwd);
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(tmp);
  if (profile === 'restored') restoreSyntheticProfile();
  // Copy the baked artifacts so children can write only to disposable caches, at the same paths in each case.
  for (const [state, source, target] of [[nodeCache, bakedNode, nodeDir], [jitiCache, bakedJiti, jitiDir]]) {
    if (state === 'baked') cpSync(source, target, { recursive: true });
    else mkdirSync(target);
  }
  process.env.TMPDIR = tmp;
  process.env.NODE_COMPILE_CACHE = nodeDir;
  const before = pids();
  assert.deepEqual(children(), []);
  assert.deepEqual(listeners(), []);
  const services = createPiWebServices({ runtimeDir, cwd, profileRestored: () => true });
  const info = console.info;
  const records = [];
  console.info = (message, ...args) => {
    if (typeof message === 'string' && message.startsWith(bootPrefix)) records.push(JSON.parse(message.slice(bootPrefix.length)));
    else info(message, ...args);
  };
  let timer;
  let timing;
  let stockPids = [];
  try {
    await Promise.race([services.start(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Pi Web startup exceeded its diagnostic budget')), startupLimitMs);
    })]);
    clearTimeout(timer);
    assert.equal(records.length, 1, 'production boot timing record required');
    const { launchMs, sessiondListenMs, gatewayListenMs, healthyMs, listedMs, readyMs } = records[0];
    for (const ms of [launchMs, healthyMs, listedMs, readyMs]) assert.ok(Number.isSafeInteger(ms) && ms >= 0);
    assert.ok(launchMs <= healthyMs && healthyMs <= listedMs && listedMs <= readyMs && readyMs <= startupLimitMs);
    // Null means the supervisor did not observe a stock stdout marker; health is separate evidence.
    for (const ms of [sessiondListenMs, gatewayListenMs]) {
      assert.ok(ms === null || Number.isSafeInteger(ms) && ms >= launchMs && ms <= readyMs);
    }
    timing = { launchMs, sessiondListenMs, gatewayListenMs, healthyMs, listedMs, readyMs };
    assert.ok(services.running());
    stockPids = children();
    assert.equal(stockPids.length, 2);
    assert.deepEqual(listeners(), [`0100007F:${PI_WEB_PORT.toString(16).toUpperCase().padStart(4, '0')}`]);
    assert.ok(socketBound(daemonSocket), 'stock daemon must bind the private socket');
    const health = await services.request('/api/sessiond/health');
    assert.equal(health.ok, true);
    assert.equal(health.activeSessions, 0);
    assert.equal(health.version.available, true);
    assert.equal(health.version.piVersion, piVersion);
  } finally {
    clearTimeout(timer);
    console.info = info;
    await services.close();
    assert.equal(services.running(), false);
    assert.deepEqual(children(), []);
    for (const pid of stockPids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.deepEqual(pids(), before, 'no descendants may escape to the private PID namespace');
    assert.deepEqual(listeners(), []);
    assert.equal(socketBound(daemonSocket), false);
  }
  console.log(JSON.stringify({ profile, nodeCache, jitiCache, ...timing, activeSessions: 0, childrenReaped: true }));
}

const scratch = mkdtempSync('/tmp/pi-web-startup-');
const root = join(scratch, 'case');
Object.assign(process.env, { HOME: home, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' });
console.log(JSON.stringify({ webVersion, piVersion, nodeVersion: process.version, startupLimitMs,
  ready: 'Host supervisor only; profile already present; no Chat session or browser',
  cacheStates: 'initial on-disk inputs, not verified hits; shared OS page cache uncontrolled' }));
try {
  for (const [profile, nodeCache, jitiCache] of [
    ['scratch', 'baked', 'baked'],
    ['restored', 'baked', 'baked'], // control: only the profile changes above
    ['restored', 'empty', 'baked'], // against the restored control: only Node cache changes
    ['restored', 'baked', 'empty'], // against the restored control: only Jiti cache changes
  ]) {
    mkdirSync(root);
    try {
      await measure(profile, nodeCache, jitiCache, root);
    } catch (cause) {
      throw new Error(`Pi Web diagnostic failed: ${profile}, Node ${nodeCache}, Jiti ${jitiCache}`, { cause });
    } finally {
      delete process.env.NODE_COMPILE_CACHE;
      delete process.env.TMPDIR;
      rmSync(root, { recursive: true, force: true });
      for (const name of readdirSync(home)) rmSync(join(home, name), { recursive: true, force: true });
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
