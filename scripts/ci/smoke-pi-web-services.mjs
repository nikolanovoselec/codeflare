// Non-deploy CI only: this requires the isolated Node image and locked mounts in test.yml.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPiWebServices, PI_WEB_PORT } from '../../host/dist/pi-web-services.js';

const installRoot = '/opt/codeflare/pi-web';
const webName = '@jmfederico/pi-web';
const piName = '@earendil-works/pi-coding-agent';
const toolsRoot = '/opt/codeflare/npm-tools';
const webPackage = join(installRoot, 'node_modules', webName);
const piPackage = join(toolsRoot, 'node_modules', piName);
const bundled = join(webPackage, 'dist/pi-packages');
const read = (path) => readFileSync(path, 'utf8');
const json = (path) => JSON.parse(read(path));
const children = () => read(`/proc/self/task/${process.pid}/children`).trim().split(/\s+/).filter(Boolean).map(Number);

function listeners() {
  // A successful loopback request would also pass for an unsafe wildcard bind.
  // This private network namespace has no other TCP listeners (including sessiond).
  return ['tcp', 'tcp6'].flatMap((table) => read(`/proc/net/${table}`).trim().split('\n').slice(1).flatMap((row) => {
    const [, local, , state] = row.trim().split(/\s+/);
    return state === '0A' ? [local] : [];
  }));
}

async function connectToDaemon(path) {
  const socket = createConnection({ path, signal: AbortSignal.timeout(3000) });
  try { await once(socket, 'connect'); }
  finally { socket.destroy(); }
}

const { version: piWebVersion } = json(join(webPackage, 'package.json'));
const { version: piVersion, bin } = json(join(piPackage, 'package.json'));
assert.equal(piWebVersion, json(join(installRoot, 'package.json')).dependencies[webName]);
assert.equal(piVersion, json(join(toolsRoot, 'package.json')).dependencies[piName]);
assert.equal(realpathSync('/usr/local/bin/pi'), join(piPackage, bin.pi), 'CLI must link to this managed SDK');

const home = mkdtempSync('/tmp/pi-web-services-');
process.env.HOME = home;
const cwd = join(home, 'workspace');
const runtimeDir = join(home, 'run/pi-web');
const daemonSocket = join(runtimeDir, 'daemon.sock');
const agentDir = join(home, '.pi/agent');
// Same source basename, unrelated user package. Dismissal must not match by basename or wipe user packages.
const localWorkflows = join(home, 'custom/workflows');
let restored = false;
const options = { runtimeDir, cwd, cloneRestored: () => restored };
let services = createPiWebServices(options);

async function checkReady() {
  assert.ok(services.running());
  assert.deepEqual(listeners(), [`0100007F:${PI_WEB_PORT.toString(16).toUpperCase().padStart(4, '0')}`], 'only the loopback web/API may listen on TCP');
  assert.ok(statSync(daemonSocket).isSocket(), 'sessiond must bind the private runtime socket');
  await connectToDaemon(daemonSocket);
  const health = await services.request('/api/sessiond/health');
  assert.equal(health.ok, true);
  assert.equal(health.activeSessions, 0, 'startup must not open an agent session');
  assert.equal(health.version.available, true);
  assert.equal(health.version.piVersion, piVersion, 'the actual daemon must load the managed Pi SDK');

  const { plugins } = await services.request('/pi-web-plugins/manifest.json');
  const ids = plugins.map(({ id }) => id);
  assert.ok(ids.includes('files') && ids.includes('pi-web.terminal'), 'retain stock Files and required Terminal');
  assert.ok(!ids.includes('git') && !ids.includes('workflows'), 'stock browser manifest must not advertise Git or Workflows');

  const { packages } = await services.request('/api/pi-packages');
  const sources = packages.filter(({ scope }) => scope === 'user').map(({ source }) => source).sort();
  assert.ok(!sources.includes(join(bundled, 'workflows')), 'dismiss the exact bundled Workflows source');
  for (const source of [localWorkflows, ...['mcp-manager', 'relays', 'session-naming'].map((name) => join(bundled, name))]) {
    assert.ok(sources.includes(source), `preserve unrelated registration: ${source}`);
  }
  return sources;
}

async function closeAndCheckReaping() {
  const pids = children();
  assert.equal(pids.length, 2, 'a single stock web/API + sessiond pair should own the private endpoints');
  await Promise.all([services.close(), services.close()]);
  await services.close();
  assert.equal(services.running(), false);
  assert.deepEqual(listeners(), [], 'close must release the web/API listener');
  await assert.rejects(connectToDaemon(daemonSocket), (error) => error.code === 'ENOENT' || error.code === 'ECONNREFUSED');
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `child ${pid} must be reaped, not left as a zombie`);
  assert.deepEqual(children(), []);
}

try {
  for (const dir of [cwd, runtimeDir, agentDir, localWorkflows]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(localWorkflows, 'package.json'), JSON.stringify({ name: 'smoke-user-workflows', version: '1.0.0' }));
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: [localWorkflows] }));

  const start = () => services.start().then(() => assert.ok(restored, 'start cannot resolve before clone restore'));
  await Promise.all([start(), start(), (async () => {
    // Span multiple supervisor polling intervals with clone restore still held.
    await delay(600);
    assert.equal(services.running(), false);
    assert.deepEqual(children(), [], 'do not launch stock processes before clone restore');
    assert.deepEqual(listeners(), []);
    assert.equal(existsSync(daemonSocket), false);
    restored = true;
  })()]);
  const firstSources = await checkReady();
  await closeAndCheckReaping();

  // Reboot the supervisor with the same profile and stock data directory.
  services = createPiWebServices(options);
  await services.start();
  assert.deepEqual(await checkReady(), firstSources, 'Workflows stays dismissed and other registrations survive restart');
  const { id } = await services.request('/api/sessions', { cwd });
  assert.ok(id);
  const commands = await services.request(`/api/sessions/${encodeURIComponent(id)}/commands?${new URLSearchParams({ cwd })}`);
  assert.ok(!commands.some(({ name }) => name === 'worktree'), 'a real stock Chat session must not offer /worktree');
  await closeAndCheckReaping();
  console.log(JSON.stringify({ result: 'PI_WEB_SERVICES_SMOKE_OK', piWebVersion, piVersion }));
} finally {
  await services.close();
  rmSync(home, { recursive: true, force: true });
}
