import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

function startConsult(home) {
  const repo = fileURLToPath(new URL('../../../../', import.meta.url));
  const lines = readFileSync(join(repo, 'entrypoint.sh'), 'utf8').split('\n');
  function functionSource(name) {
    const start = lines.findIndex((line) => line === `${name}() {`);
    const end = lines.findIndex((line, index) => index > start && line === '}');
    if (start < 0 || end < 0) throw new Error(`missing production helper ${name}`);
    return lines.slice(start, end + 1).join('\n');
  }
  const functions = ['configure_pi_mcp_adapter', '_merge_consult_llm_mcp', '_remove_consult_llm_mcp', '_remove_disabled_consult_llm', 'configure_consult_llm'].map(functionSource).join('\n');
  return spawnSync('bash', ['-c', `${functions}\nconfigure_pi_mcp_adapter "$MIGRATION_MODULE"\nconfigure_consult_llm`], {
    encoding: 'utf8',
    env: { ...process.env, USER_HOME: home, USER_CLAUDE_JSON: join(home, '.claude.json'),
      MIGRATION_MODULE: join(repo, 'preseed/agents/pi/extensions/00-mcp-adapter-config.ts'),
      CODEFLARE_OPENAI_API_KEY: 'synthetic-openai', CODEFLARE_GEMINI_API_KEY: '', ENTERPRISE_MODE: '',
    },
  });
}


test('REQ-AGENT-069 AC1/AC2: locked adapter exposes consult through mcp and starts its process only on proxy use', { timeout: 30_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'pi-consult-proxy-'));
  const directory = join(home, '.pi/agent');
  mkdirSync(directory, { recursive: true });
  const f = { home, directory, target: join(directory, 'mcp-adapter.json') };
  let previous;
  let shutdown = async () => {};
  t.after(async () => {
    try {
      await shutdown();
    } finally {
      for (const [name, value] of Object.entries(previous ?? {})) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });
  const repo = fileURLToPath(new URL('../../../../', import.meta.url));
  const archivePath = join(repo, 'host/__fixtures__/pi-mcp-adapter-3.3.0.tgz');
  const lock = JSON.parse(readFileSync(join(repo, 'preseed/agents/pi/package-lock.json'), 'utf8'));
  const pinned = lock.packages['node_modules/pi-mcp-adapter'];
  // Exact locked artifact contract, not the agent's differently pinned install.
  assert.equal(pinned.version, '3.3.0');
  assert.equal(`sha512-${createHash('sha512').update(readFileSync(archivePath)).digest('base64')}`, pinned.integrity);
  const vendor = join(f.home, 'vendor');
  mkdirSync(vendor);
  execFileSync('tar', ['-xzf', archivePath, '-C', vendor], { stdio: 'ignore' });
  const manifest = JSON.parse(readFileSync(join(vendor, 'package/package.json'), 'utf8'));
  assert.deepEqual(manifest.pi.extensions, ['./index.ts']);

  // Transpile the complete declared artifact for Node's host test runner. No
  // vendor function, SDK client, process transport or lifecycle is substituted.
  // CI must provide the real dependencies installed from the preseed lock;
  // missing dependencies are a setup failure, never a skipped behavioral pass.
  symlinkSync(join(repo, 'preseed/agents/pi/node_modules'), join(vendor, 'node_modules'), 'dir');
  const { build } = await import('esbuild');
  const output = join(vendor, 'adapter.mjs');
  await build({ entryPoints: [join(vendor, 'package', manifest.pi.extensions[0])], outfile: output,
    bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent' });

  const bin = join(f.home, 'bin');
  mkdirSync(bin);
  const service = join(bin, 'consult-llm-mcp');
  copyFileSync(join(repo, 'host/__fixtures__/consult-llm-mcp.mjs'), service);
  chmodSync(service, 0o755);
  const receipt = join(f.home, 'consult-service.jsonl');
  const environment = ['HOME', 'PATH', 'XDG_CONFIG_HOME', 'PI_CODING_AGENT_DIR', 'PI_PACKAGE_DIR',
    'MCP_DIRECT_TOOLS', 'PI_MCP_CONFIG_MODE', 'CODEFLARE_Q17_RECEIPT', 'CODEFLARE_Q17_PHASE'];
  previous = Object.fromEntries(environment.map(name => [name, process.env[name]]));
  for (const name of environment) delete process.env[name];
  process.env.HOME = f.home;
  process.env.PATH = `${bin}:${previous.PATH}`;
  process.env.XDG_CONFIG_HOME = join(f.home, '.config');
  process.env.PI_CODING_AGENT_DIR = f.directory;
  process.env.CODEFLARE_Q17_RECEIPT = receipt;
  process.env.CODEFLARE_Q17_PHASE = 'session-start';
  const configured = startConsult(f.home);
  assert.equal(configured.status, 0, configured.stderr);
  assert.equal(existsSync(join(f.directory, 'mcp-cache.json')), false, 'fresh bootstrap must not borrow a warmed catalog');

  const handlers = new Map();
  const listeners = new Map();
  const tools = new Map();
  const commands = new Map();
  const entries = [];
  let activeTools = ['read', 'bash'];
  const pi = {
    on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    events: {
      on(name, handler) {
        listeners.set(name, [...(listeners.get(name) ?? []), handler]);
        return () => listeners.set(name, listeners.get(name).filter(candidate => candidate !== handler));
      },
      emit(name, payload) { for (const listener of listeners.get(name) ?? []) listener(payload); },
    },
    registerFlag() {}, getFlag: () => undefined,
    registerCommand: (name, command) => commands.set(name, command),
    getCommands: () => [...commands.keys()].map(name => ({ name, sourceInfo: { path: 'adapter-fixture' } })),
    registerTool(tool) {
      tools.set(tool.name, tool);
      if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
    },
    getAllTools: () => [...tools.values()],
    getActiveTools: () => [...activeTools],
    setActiveTools: names => { activeTools = [...names]; },
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
    sendMessage: message => entries.push({ type: 'custom_message', ...message }),
  };
  const ctx = { cwd: f.home, mode: 'print', hasUI: false,
    sessionManager: { getBranch: () => entries, getEntries: () => entries },
    ui: { setStatus() {}, notify() {} }, modelRegistry: undefined, signal: undefined };
  const emit = async (name, event = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };
  const { createMcpAdapter } = await import(pathToFileURL(output).href);
  createMcpAdapter({ configPath: f.target })(pi);
  shutdown = () => emit('session_shutdown');
  await emit('session_start');
  assert.ok(activeTools.includes('mcp'), 'consult must be reachable through the actual registered proxy');
  const hasDirectConsult = () => activeTools.some(name => {
    const parameters = tools.get(name)?.parameters?.properties;
    return parameters && Object.hasOwn(parameters, 'prompt') && Object.hasOwn(parameters, 'model');
  });
  assert.equal(hasDirectConsult(), false, 'consult must not expose its direct prompt/model tool schema');
  const startedBeforeUse = existsSync(receipt);
  process.env.CODEFLARE_Q17_PHASE = 'proxy-use';
  const args = { model: 'openai', prompt: 'Compare the stated alternatives.', task_mode: 'general' };
  const result = await tools.get('mcp').execute('explicit-consult', { server: 'consult-llm', tool: 'consult_llm', args }, undefined, undefined, ctx);
  assert.equal(result.details.error, undefined);
  assert.equal(result.details.server, 'consult-llm');
  assert.equal(result.details.tool, 'consult_llm');
  assert.match(result.content.filter(block => block.type === 'text').map(block => block.text).join('\n'), /Fixture external answer/);
  const observations = readFileSync(receipt, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(observations.find(event => event.event === 'consulted'), { event: 'consulted', arguments: args, configuredCredential: true });
  // External process receipts distinguish real start-on-use from merely setting
  // lifecycle:"lazy". The child inherits the phase at the actual launch boundary.
  assert.equal(startedBeforeUse, false, 'session startup must not launch consult');
  assert.equal(observations.find(event => event.event === 'started').phase, 'proxy-use');
  assert.ok(activeTools.includes('mcp'), 'proxy use must retain the registered mcp surface');
  assert.equal(hasDirectConsult(), false, 'proxy use must not expose the direct consult prompt/model tool schema');
});
