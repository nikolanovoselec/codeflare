import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
async function fixture(t, serverTimeout, environmentCase) {
  const home = mkdtempSync(join(tmpdir(), 'pi-mcp-adapter-consult-'));
  const directory = join(home, '.pi/agent');
  mkdirSync(directory, { recursive: true });
  const previous = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.HOME = home; process.env.PI_CODING_AGENT_DIR = directory;
  let session;
  t.after(async () => {
    try {
      if (session) { try { await session.extensionRunner.emit({ type: 'session_shutdown' }); } finally { session.dispose(); } }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });
  writeFileSync(join(directory, 'settings.json'), JSON.stringify({ packages: ['npm:pi-mcp-adapter@5.3.1'], extensions: ['-builtin:mcp'] }));
  const dependencies = join(repo, 'preseed/agents/pi/node_modules');
  const packageRoot = join(dependencies, 'pi-mcp-adapter');
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(repo, 'preseed/agents/pi/package-lock.json'), 'utf8'));
  const selected = JSON.parse(readFileSync(join(repo, 'preseed/agents/pi/package.json'), 'utf8'));
  // Exact installed artifact is the intentional managed dependency contract.
  assert.equal(manifest.version, lock.packages['node_modules/pi-mcp-adapter'].version);
  assert.equal(manifest.version, selected.dependencies['pi-mcp-adapter']);
  symlinkSync(dependencies, join(home, 'node_modules'), 'dir');
  const { build } = await import('esbuild');
  await build({ entryPoints: { extension: join(packageRoot, manifest.pi.extensions[0]), capability: join(repo, 'preseed/agents/pi/extensions/capability.ts') }, outdir: home,
    bundle: true, packages: 'external', platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' }, logLevel: 'silent' });
  const receipt = join(home, 'receipt.jsonl');
  const configPath = join(directory, 'mcp-adapter.json');
  // Native schema decodes !! once; stock schema treats both bangs literally.
  const stockSchema = environmentCase && !environmentCase.legacy;
  const selectedPath = stockSchema ? join(directory, 'mcp.json') : configPath;
  writeFileSync(selectedPath, JSON.stringify({ settings: { requestTimeoutMs: 360000, deferWithMissingMetadata: true }, mcpServers: {
    'consult-llm': { command: process.execPath, args: [join(repo, 'host/__fixtures__/pi-mcp-extension-server.mjs'), receipt, ...(environmentCase ? [environmentCase.expected] : [])],
      lifecycle: 'lazy', ...(stockSchema ? {} : { directTools: 'search', idleTimeout: 10 }),
      ...(environmentCase ? { env: { CODEFLARE_SYNTHETIC_LITERAL: environmentCase.input } } : {}),
      ...(serverTimeout ? { requestTimeoutMs: serverTimeout } : {}) },
  } }));
  if (environmentCase) {
    const { default: prepareLoad, preparePiMcpAdapterConfig } = await import(pathToFileURL(join(repo, 'preseed/agents/pi/extensions/00-mcp-adapter-config.ts')).href);
    if (environmentCase.regenerate) assert.equal(preparePiMcpAdapterConfig(directory, true), true);
    else prepareLoad({}, { HOME: home });
    assert.equal(existsSync(configPath), true);
  }
  const { createMcpAdapter } = await import(pathToFileURL(join(home, 'extension.mjs')).href);
  const { capabilityExtension } = await import(pathToFileURL(join(home, 'capability.mjs')).href);
  const sdk = await import(pathToFileURL(join(dependencies, '@earendil-works/pi-coding-agent/dist/index.js')).href);
  sdk.initTheme();
  const nativeConfig = JSON.parse(readFileSync(configPath, 'utf8'));
  if (stockSchema) Object.assign(nativeConfig.mcpServers['consult-llm'], { directTools: 'search', idleTimeout: 10 });
  const settingsManager = sdk.SettingsManager.inMemory({ packages: [], extensions: ['-builtin:mcp'] });
  const loader = new sdk.DefaultResourceLoader({ cwd: home, agentDir: directory, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [createMcpAdapter({ config: nativeConfig }), capabilityExtension] });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(home, 'auth.json'), modelsPath: join(home, 'models.json') });
  ({ session } = await sdk.createAgentSession({ cwd: home, agentDir: directory, resourceLoader: loader, settingsManager,
    modelRuntime, sessionManager: sdk.SessionManager.inMemory(home), noTools: true }));
  const errors = [];
  await session.bindExtensions({ mode: 'print', onError: error => errors.push(error) });
  assert.deepEqual(errors, []);
  const call = (name, args = {}, signal) => {
    const tool = session.getToolDefinition(name); assert.ok(tool, `registered tool: ${name}`);
    return tool.execute('synthetic', args, signal, undefined, session.extensionRunner.createToolContext('synthetic', undefined));
  };
  const observations = () => existsSync(receipt) ? readFileSync(receipt, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  let consultName;
  const connect = async () => {
    const result = await call('mcp', { connect: 'consult-llm' });
    assert.equal(result.details?.error, undefined, JSON.stringify(result));
    const found = await call('mcp', { search: 'synthetic consult', server: 'consult-llm' });
    consultName = found.details.matches[0]?.tool; assert.ok(consultName);
    return result;
  };
  const consult = (args, signal) => call(consultName, args, signal);
  return { session, call, observations, connect, consult, name: () => consultName,
    shutdown: () => session.extensionRunner.emit({ type: 'session_shutdown' }) };
}
async function until(predicate, milliseconds = 10000) {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('Synthetic server outcome did not arrive'); await delay(20); }
}

test('REQ-AGENT-069 AC1/AC2: native cold discovery is metadata-only until explicit consultation and supports exact capability activation', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  assert.deepEqual(f.observations(), [], 'session startup remains deferred');
  await f.call('mcp');
  const metadataMethods = f.observations().filter(row => row.event === 'rpc').map(row => row.method);
  assert.ok(metadataMethods.includes('initialize'));
  assert.ok(metadataMethods.includes('tools/list'));
  const allowedMetadata = new Set(['initialize', 'notifications/initialized', 'tools/list', 'resources/list', 'prompts/list', 'ping']);
  assert.ok(metadataMethods.every(method => allowedMetadata.has(method)), 'cold discovery is metadata-only');
  assert.deepEqual(f.observations().filter(row => row.event === 'called'), [], 'discovery cannot invoke external consultation');
  await f.connect();
  const discovery = await f.call('capability', { query: 'tool:synthetic consult' });
  assert.equal(discovery.details.recommended?.name, f.name());
  const activated = await f.call('capability', { name: f.name() });
  assert.ok(activated);
  assert.ok(f.session.getActiveToolNames().includes(f.name()));
  assert.deepEqual(f.observations().filter(row => row.event === 'called'), [], 'connection and tool activation do not invoke consultation');
  const result = await f.consult({ operation: 'answer' });
  assert.match(JSON.stringify(result.content), /Fixture external answer/);
});

test('REQ-BROWSER-009: configured six-minute call budget permits a response beyond thirty seconds', { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.connect();
  assert.match(JSON.stringify((await f.consult({ operation: 'answer', delayMs: 31000 })).content), /Fixture external answer/);
});

test('REQ-BROWSER-009: native request timeout resets on progress and cancellation reaches the real server', { timeout: 20000 }, async t => {
  const f = await fixture(t, 1000); await f.connect();
  const progress = await f.consult({ operation: 'progress', delayMs: 2500 });
  assert.match(JSON.stringify(progress.content), /Fixture external answer/);
  const silent = await f.consult({ operation: 'answer', delayMs: 2500 });
  assert.equal(silent.details.error, 'call_failed'); assert.match(JSON.stringify(silent), /timeout|timed out/i);
  const controller = new AbortController();
  const receiptOffset = f.observations().length;
  const request = f.consult({ operation: 'answer', delayMs: 4000 }, controller.signal);
  await until(() => f.observations().slice(receiptOffset).some(row => row.event === 'called' && row.operation === 'answer'));
  controller.abort();
  const cancelled = await request;
  assert.equal(cancelled.details.error, 'aborted'); assert.match(JSON.stringify(cancelled), /cancel|abort/i);
  await until(() => f.observations().some(row => row.event === 'cancelled' && row.operation === 'answer'));
});

test('REQ-AGENT-069: transport recovery never replays an uncertain mutation and shutdown releases child processes', { timeout: 25000 }, async t => {
  const f = await fixture(t); await f.connect();
  assert.equal((await f.consult({ operation: 'uncertain-mutation' })).details.error, 'call_failed');
  await f.connect();
  assert.match(JSON.stringify((await f.consult({ operation: 'answer' })).content), /Fixture external answer/);
  assert.equal(f.observations().filter(row => row.event === 'mutated').length, 1, 'uncertain effect occurs once');
  const pids = f.observations().filter(row => row.event === 'started').map(row => row.pid);
  await f.shutdown();
  await until(() => pids.every(pid => { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } }));
});

for (const regenerate of [false, true]) for (const legacy of [false, true]) {
  test(`REQ-AGENT-217: actual stdio server receives the selected schema's literal env (legacy=${legacy}, regenerate=${regenerate})`, { timeout: 20000 }, async t => {
    const f = await fixture(t, undefined, { legacy, regenerate, input: '!!synthetic-runtime', expected: legacy ? '!synthetic-runtime' : '!!synthetic-runtime' });
    assert.deepEqual(f.observations(), [], 'preparation does not evaluate commands or start servers');
    await f.connect();
    assert.equal(f.observations().find(row => row.event === 'started')?.literalMatches, true);
    assert.match(JSON.stringify((await f.consult({ operation: 'answer' })).content), /Fixture external answer/);
  });
}
