import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const ciModules = join(repo, 'preseed/agents/pi/node_modules');
const modules = existsSync(ciModules) ? ciModules : '/opt/codeflare/pi-agent/npm/node_modules';
const name = '@dumbmice/pi-todo-loop';
const patch = join(repo, 'scripts/patch-pi-todo-loop-default-pause.mjs');

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'pi-todoloop-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const imageModules = join(home, 'image', 'node_modules');
  const pkg = join(imageModules, name);
  cpSync(join(modules, name), pkg, { recursive: true });
  return { home, imageModules, pkg };
}

function transform(pkg) {
  const result = spawnSync(process.execPath, [patch, pkg], { encoding: 'utf8', timeout: 10_000 });
  if (result.error) throw result.error;
  return result;
}

test('REQ-AGENT-111: Pi registers Todo Loop paused for startup, new and resumed sessions', async (t) => {
  const { home, imageModules, pkg } = fixture(t);
  for (let i = 0; i < 2; i++) {
    const result = transform(pkg);
    assert.equal(result.status, 0, result.stderr);
  }
  const agentDir = join(home, '.pi', 'agent');
  const npmDir = join(agentDir, 'npm');
  const cwd = join(home, 'workspace');
  const sessions = join(home, 'sessions');
  mkdirSync(npmDir, { recursive: true });
  mkdirSync(cwd);
  // Same resolver path as a restored profile: settings are synced, npm modules are image-owned.
  symlinkSync(imageModules, join(npmDir, 'node_modules'), 'dir');
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({
    packages: [`npm:${name}@0.4.0`], retry: { enabled: false }, compaction: { enabled: false },
  }));
  writeFileSync(join(agentDir, 'todo-loop.json'), '{"maxRounds":1}');
  for (const [key, value] of Object.entries({ HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', TMPDIR: home })) {
    const original = process.env[key];
    t.after(() => { if (original === undefined) delete process.env[key]; else process.env[key] = original; });
    process.env[key] = value;
  }
  const load = (name) => import(pathToFileURL(join(modules, '@earendil-works', name, 'dist/index.js')).href);
  const { createAssistantMessageEventStream } = await load('pi-ai');
  const { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, ModelRuntime, SessionManager } = await load('pi-coding-agent');
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), refreshOnCreate: false });
  await modelRuntime.setRuntimeApiKey('anthropic', 'offline-test-key');
  const model = modelRuntime.getModels('anthropic')[0];
  assert.ok(model);
  const createRuntime = (sessionManager) => createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime });
    return { ...await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model }), services,
      diagnostics: services.diagnostics };
  }, { cwd, agentDir, sessionManager });

  let replies = 0;
  const notifications = [];
  async function bind(session, mode) {
    session.agent.streamFunction = () => {
      replies++;
      const stream = createAssistantMessageEventStream();
      const message = {
        role: 'assistant', content: [{ type: 'text', text: 'Synthetic reply' }], api: model.api,
        provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      stream.push({ type: 'done', reason: 'stop', message });
      stream.end(message);
      return stream;
    };
    await session.bindExtensions({ mode, uiContext: { notify: (message) => notifications.push(message) } });
  }
  async function status(session, mode) {
    notifications.length = 0;
    await session.prompt('/todoloop status');
    assert.equal(notifications.length, 1, 'one registered command must report status once');
    assert.match(notifications[0], new RegExp(`^todo-loop ${mode}(?:[ (]|\\n)`));
    assert.match(notifications[0], /asked to continue: \d+ of 1/);
    assert.ok(session.getAllTools().some(({ name }) => name === 'todo_loop_block'));
  }
  async function prompt(session, count) {
    replies = 0;
    await session.prompt('A synthetic user request');
    assert.equal(replies, count);
  }
  const taskList = { tasks: [{ id: 1, subject: 'Open test task', status: 'pending' }] };
  const runtime = await createRuntime(SessionManager.create(cwd, sessions));
  let originalSessionFile;
  try {
    await bind(runtime.session, 'interactive');
    runtime.session.sessionManager.appendCustomEntry('rpiv-todo-state', taskList);
    await status(runtime.session, 'PAUSED');
    await prompt(runtime.session, 1);
    await runtime.session.prompt('/todoloop reset');
    await status(runtime.session, 'PAUSED');
    await runtime.session.prompt('/todoloop resume');
    await status(runtime.session, 'active');
    await prompt(runtime.session, 2);
    await runtime.session.prompt('/todoloop pause');
    await status(runtime.session, 'PAUSED');
    await runtime.session.prompt('/todoloop resume');
    originalSessionFile = runtime.session.sessionFile;
    assert.ok(originalSessionFile);
    await runtime.session.reload();
    await bind(runtime.session, 'interactive');
    await status(runtime.session, 'PAUSED');
    await runtime.session.prompt('/todoloop resume');
    await runtime.newSession();
    await bind(runtime.session, 'interactive');
    await status(runtime.session, 'PAUSED');
    await runtime.session.prompt('/todoloop resume');
    await runtime.switchSession(originalSessionFile);
    await bind(runtime.session, 'interactive');
    await status(runtime.session, 'PAUSED');
    assert.match(notifications[0], /tasks open: 1 of 1/);
    await prompt(runtime.session, 1);
  } finally {
    await runtime.dispose();
  }

  // Pi Web uses a fresh SDK session from the same agent directory in RPC mode.
  const embedded = await createRuntime(SessionManager.open(originalSessionFile, sessions));
  try {
    await bind(embedded.session, 'rpc');
    await status(embedded.session, 'PAUSED');
    assert.match(notifications[0], /tasks open: 1 of 1/);
    await prompt(embedded.session, 1);
  } finally {
    await embedded.dispose();
  }
});

test('REQ-AGENT-111: Todo Loop transform fails closed on version, entrypoint or source drift', (t) => {
  const { pkg } = fixture(t);
  const manifest = join(pkg, 'package.json');
  const original = readFileSync(manifest, 'utf8');
  const entrypoint = join(pkg, 'src/index.ts');
  const source = readFileSync(entrypoint, 'utf8');
  const reject = (expected) => {
    const result = transform(pkg);
    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
  };
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(original), version: '0.4.1' }));
  reject(/unsupported Todo Loop package/i);
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(original), pi: { extensions: ['./somewhere.ts'] } }));
  reject(/extension entrypoint/i);
  writeFileSync(manifest, original);
  writeFileSync(entrypoint, `${source}\n// unrelated source drift\n`);
  reject(/source digest/i);
  assert.equal(readFileSync(entrypoint, 'utf8'), `${source}\n// unrelated source drift\n`, 'rejection must not write the candidate');
});
