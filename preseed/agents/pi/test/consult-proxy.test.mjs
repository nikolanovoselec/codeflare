import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
async function fixture(t, serverTimeout, environmentCase) {
  const home = mkdtempSync(join(tmpdir(), 'pi-mcp-extension-'));
  const directory = join(home, '.pi/agent');
  mkdirSync(directory, { recursive: true });
  let shutdown = async () => {};
  t.after(async () => { try { await shutdown(); } finally { rmSync(home, { recursive: true, force: true }); } });
  const dependencies = join(repo, 'preseed/agents/pi/node_modules');
  const packageRoot = join(dependencies, 'pi-mcp-extension');
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(repo, 'preseed/agents/pi/package-lock.json'), 'utf8'));
  // Installed artifact identity is the intentional managed dependency contract.
  assert.equal(manifest.version, lock.packages['node_modules/pi-mcp-extension'].version);
  const selected = JSON.parse(readFileSync(join(repo, 'preseed/agents/pi/package.json'), 'utf8'));
  assert.equal(manifest.version, selected.dependencies['pi-mcp-extension']);
  symlinkSync(dependencies, join(home, 'node_modules'), 'dir');
  const { build } = await import('esbuild');
  await build({ entryPoints: { extension: join(packageRoot, manifest.pi.extensions[0]), capability: join(repo, 'preseed/agents/pi/extensions/capability.ts') }, outdir: home,
    bundle: true, packages: 'external', platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' }, logLevel: 'silent' });
  const receipt = join(home, 'receipt.jsonl');
  const configPath = join(directory, 'mcp.json');
  const selectedPath = environmentCase?.legacy ? join(directory, 'mcp-adapter.json') : configPath;
  writeFileSync(selectedPath, JSON.stringify({ settings: { requestTimeoutMs: 360000 }, mcpServers: {
    'consult-llm': { command: process.execPath, args: [join(repo, 'host/__fixtures__/pi-mcp-extension-server.mjs'), receipt, ...(environmentCase ? [environmentCase.expected] : [])], lifecycle: 'lazy',
      ...(environmentCase ? { env: { CODEFLARE_SYNTHETIC_LITERAL: environmentCase.input } } : {}),
      ...(serverTimeout ? { requestTimeoutMs: serverTimeout } : {}) },
  } }));
  if (environmentCase) {
    const { default: prepareLoad, migratePiMcpAdapterConfig } = await import(pathToFileURL(join(repo, 'preseed/agents/pi/extensions/00-mcp-adapter-config.ts')).href);
    if (environmentCase.regenerate) assert.equal(migratePiMcpAdapterConfig(directory, true, true), true);
    else prepareLoad({}, { HOME: home });
    assert.equal(existsSync(configPath), true);
  }
  const handlers = new Map(), tools = new Map();
  let active = ['read', 'bash', 'edit', 'write', 'capability'];
  const pi = {
    on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerCommand() {}, getMcpServers: () => [],
    registerTool(tool) { tools.set(tool.name, tool); if (!active.includes(tool.name)) active.push(tool.name); },
    getAllTools: () => [...tools.values()], getActiveTools: () => [...active], setActiveTools: names => { active = [...names]; },
  };
  const ctx = { cwd: home, hasUI: false, mode: 'print', isProjectTrusted: () => false,
    ui: { notify() {}, setStatus() {}, setWidget() {} } };
  const emit = async name => { for (const handler of handlers.get(name) ?? []) await handler({}, ctx); };
  const { default: register } = await import(pathToFileURL(join(home, 'extension.mjs')).href);
  const { capabilityExtension } = await import(pathToFileURL(join(home, 'capability.mjs')).href);
  capabilityExtension(pi);
  await register(pi, { bootstrapCwd: home, globalConfigPath: configPath, authStorageDir: join(home, 'auth') });
  shutdown = () => emit('session_shutdown');
  await emit('session_start');
  const call = (name, args = {}, signal) => tools.get(name).execute('synthetic', args, signal, undefined, ctx);
  const observations = () => existsSync(receipt) ? readFileSync(receipt, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const activate = name => call('capability', { name });
  const connect = () => call('mcp_connect', { name: 'consult-llm' });
  const consult = () => [...tools.keys()].find(name => name !== 'capability' && tools.get(name).parameters?.properties?.operation);
  return { pi, call, observations, activate, connect, consult, shutdown };
}

async function until(predicate, milliseconds = 10000) {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Synthetic server outcome did not arrive');
    await delay(20);
  }
}

// This test uses the installed locked extension, real SDK and external stdio process.
test('REQ-AGENT-069 AC1/AC2: direct consult starts only on explicit connect and supports exact capability activation', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  await f.activate('mcp_status');
  await f.call('mcp_status');
  assert.deepEqual(f.observations(), [], 'status/discovery must not launch consult');
  assert.equal(f.consult(), undefined);
  await f.activate('mcp_connect');
  await f.connect();
  const discovery = await f.call('capability', { query: 'tool:synthetic consult' });
  const name = discovery.details.recommended?.name;
  assert.equal(name, f.consult(), 'capability must find the newly registered callable tool');
  f.pi.setActiveTools(['capability']);
  await assert.rejects(f.connect(), /inactive/i, 'ready must not imply tools are active');
  await f.activate(name);
  assert.ok(f.pi.getActiveTools().includes(name));
  const result = await f.call(name, { operation: 'answer' });
  assert.match(JSON.stringify(result.content), /Fixture external answer/);
  assert.equal(f.observations().filter(row => row.event === 'called').length, 1);
});

test('REQ-BROWSER-009: configured six-minute call budget permits a response beyond thirty seconds', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.connect();
  const result = await f.call(f.consult(), { operation: 'answer', delayMs: 31000 });
  assert.match(JSON.stringify(result.content), /Fixture external answer/);
});

test('REQ-BROWSER-009: request deadline is fixed and cancellation reaches the real server', { timeout: 20000 }, async t => {
  const f = await fixture(t, 1000);
  await f.connect();
  await assert.rejects(f.call(f.consult(), { operation: 'progress', delayMs: 4000 }), error => error.code === 'timeout');
  const controller = new AbortController();
  const request = f.call(f.consult(), { operation: 'answer', delayMs: 4000 }, controller.signal);
  await until(() => f.observations().some(row => row.event === 'called' && row.operation === 'answer'));
  controller.abort();
  await assert.rejects(request, /cancel/i);
  await until(() => f.observations().some(row => row.event === 'cancelled' && row.operation === 'answer'));
});

test('REQ-AGENT-069: transport recovery never replays an uncertain mutation and shutdown releases child processes', { timeout: 25000 }, async t => {
  const f = await fixture(t);
  await f.connect();
  await assert.rejects(f.call(f.consult(), { operation: 'uncertain-mutation' }));
  await until(() => f.observations().filter(row => row.event === 'started').length >= 2);
  // Explicit connect joins recovery and waits for discovery; it must not replay tools/call.
  await f.connect();
  const result = await f.call(f.consult(), { operation: 'answer' });
  assert.match(JSON.stringify(result.content), /Fixture external answer/);
  assert.equal(f.observations().filter(row => row.event === 'mutated').length, 1, 'the uncertain effect must happen only once across reconnect');
  const pids = f.observations().filter(row => row.event === 'started').map(row => row.pid);
  await f.shutdown();
  await until(() => pids.every(pid => { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } }));
});


for (const regenerate of [false, true]) {
  for (const legacy of [false, true]) {
    test(`REQ-AGENT-217: actual stdio server receives the selected schema's literal env (legacy=${legacy}, regenerate=${regenerate})`, { timeout: 20000 }, async t => {
      const f = await fixture(t, undefined, { legacy, regenerate, input: '!!synthetic-runtime', expected: legacy ? '!synthetic-runtime' : '!!synthetic-runtime' });
      assert.deepEqual(f.observations(), [], 'migration must never evaluate a command or start the server');
      await f.connect();
      assert.equal(f.observations().find(row => row.event === 'started')?.literalMatches, true,
        'the real subprocess must receive the intended literal without exposing its value');
      const result = await f.call(f.consult(), { operation: 'answer' });
      assert.match(JSON.stringify(result.content), /Fixture external answer/);
    });
  }
}
