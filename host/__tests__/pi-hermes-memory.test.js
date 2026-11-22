import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { importPiExtension } from './fixtures/pi-extension-module.mjs';

// Lifecycle ownership contract for the Codeflare adapter, not a replacement for
// native Pi/Smart Compact or real-provider/upstream-package qualification.
const runtime = () => importPiExtension('hermes-memory-runtime');
const timestamp = 1_800_000_000_000;
function originalMessages() {
  return [
    {
      role: 'system', content: 'Original permission boundary: do not deploy.', timestamp,
      sections: { policy: 'Ask before destructive operations.' },
      toolsAdded: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } }],
    },
    {
      role: 'user', timestamp,
      content: [
        { type: 'text', text: 'Please explain this image.' },
        { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' },
      ],
    },
    {
      role: 'assistant', timestamp, api: 'anthropic-messages', provider: 'anthropic', model: 'fixture',
      content: [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'README.md' } }],
      stopReason: 'toolUse', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    },
    { role: 'toolResult', toolCallId: 'read-1', toolName: 'read', timestamp,
      content: [{ type: 'text', text: 'The README contents.' }], isError: false },
    { role: 'system', content: 'Later tool policy patch.', timestamp,
      sections: { policy: 'Still no deploy permission.' }, toolsRemoved: [{ name: 'read' }] },
  ];
}

function fixture(t, files = { user: 'User prefers concise replies.', global: 'Knowledge: use the staging endpoint.', workspace: 'Workspace uses npm.' }, baseDir = tmpdir()) {
  const root = fs.mkdtempSync(join(baseDir, 'pi-hermes-memory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const memoryDir = join(root, 'Memory');
  const workspaceMemoryDir = join(memoryDir, 'Projects', 'workspace');
  fs.mkdirSync(workspaceMemoryDir, { recursive: true });
  const paths = { user: join(memoryDir, 'USER.md'), global: join(memoryDir, 'MEMORY.md'),
    workspace: join(workspaceMemoryDir, 'MEMORY.md') };
  for (const [key, value] of Object.entries(files)) fs.writeFileSync(paths[key], value);
  // failures.md is durable, but deliberately not one of the three core files.
  fs.writeFileSync(join(memoryDir, 'failures.md'), 'LESSON_NOT_PART_OF_CORE_CONTEXT');
  const transcript = join(root, 'session.jsonl');
  const messages = originalMessages();
  fs.writeFileSync(transcript, [
    { type: 'session', version: 3, id: 'root', cwd: root },
    ...messages.map((message, index) => ({ type: 'message', id: `entry-${index}`, message })),
  ].map(entry => JSON.stringify(entry) + '\n').join(''));
  return { root, memoryDir, workspaceMemoryDir, paths, transcript, messages };
}

function host(f, header = { id: 'root' }) {
  const hooks = new Map(), tools = new Map(), warnings = [];
  const append = entry => fs.appendFileSync(f.transcript, JSON.stringify(entry) + '\n');
  const pi = {
    on(name, handler) {
      const handlers = hooks.get(name) ?? [];
      handlers.push(handler);
      hooks.set(name, handlers);
      return () => hooks.set(name, handlers.filter(item => item !== handler));
    },
    registerTool(tool) { tools.set(tool.name, tool); },
    sendMessage(message) { append({ type: 'custom_message', ...message }); },
    sendUserMessage(content) { append({ type: 'message', message: { role: 'user', content } }); },
    appendEntry(customType, data) { append({ type: 'custom', customType, data }); },
  };
  const ctx = {
    cwd: f.root, hasUI: true,
    ui: { notify(message, level) { warnings.push({ message: String(message), level }); } },
    sessionManager: {
      getHeader: () => header,
      getSessionId: () => header?.id,
      getSessionFile: () => f.transcript,
      getBranch: () => f.messages.map((message, index) => ({ type: 'message', id: `entry-${index}`, message })),
    },
  };
  return {
    pi, ctx, tools, warnings,
    async emit(name, properties = {}) {
      for (const handler of hooks.get(name) ?? []) await handler({ type: name, ...properties }, ctx);
    },
    async request(messages = f.messages) {
      let current = messages;
      for (const handler of hooks.get('context_with_system') ?? []) {
        const result = await handler({ type: 'context_with_system', messages: current }, ctx);
        if (result?.messages) current = result.messages;
      }
      return current;
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Each subcase uses a fresh registry, representing an independent Pi process.
// The initializer is the external stock-package seam: it registers real event
// handlers/tools and writes real fixtures; the adapter itself is never mocked.
test('REQ-MEM-035: AC5 foreground ownership gates stock writers/tools and drains shutdown before release', async t => {
  const { attachHermesMemoryToForeground } = await runtime();
  await t.test('REQ-MEM-035: one owner; rejected helper sessions cannot learn their prompts or expose stock tools', async t => {
    const f = fixture(t), owner = host(f), child = host(f, { id: 'helper', parentSession: f.transcript });
    const registry = {}, originalSnapshot = structuredClone(f.messages), transcript = fs.readFileSync(f.transcript, 'utf8');
    const initialize = api => {
      api.on('input', event => fs.writeFileSync(f.paths.user, event.text));
      api.registerTool({ name: 'fixture_memory_read', async execute() {
        return { content: [{ type: 'text', text: fs.readFileSync(f.paths.user, 'utf8') }] };
      } });
    };
    assert.equal(await attachHermesMemoryToForeground(registry, owner.pi, initialize), true);
    assert.equal(await attachHermesMemoryToForeground(registry, child.pi, initialize), false);
    await owner.emit('input', { text: 'ROOT_PREFERENCE: use metric units', source: 'interactive' });
    await child.emit('session_start', { reason: 'startup' });
    await child.emit('input', { text: 'CHILD_REVIEW_PROMPT_NOT_A_PREFERENCE', source: 'interactive' });
    await child.emit('agent_end', { messages: child.ctx.sessionManager.getBranch() });
    assert.equal(fs.readFileSync(f.paths.user, 'utf8'), 'ROOT_PREFERENCE: use metric units');
    assert.equal(child.tools.has('fixture_memory_read'), false);
    assert.deepEqual(await child.request(), f.messages);
    const read = await owner.tools.get('fixture_memory_read').execute('read-memory', {}, undefined, undefined, owner.ctx);
    assert.equal(read.content[0].text, 'ROOT_PREFERENCE: use metric units');
    assert.deepEqual(await owner.request(), originalSnapshot, 'lifecycle ownership preserves prompt/tool/image content and ordering');
    assert.equal(fs.readFileSync(f.transcript, 'utf8'), transcript, 'ownership and memory reads do not persist synthetic memory turns');
    await child.emit('session_shutdown', { reason: 'quit' });
    assert.equal(await attachHermesMemoryToForeground(registry, child.pi, initialize), false,
      'a nonowner shutdown must not release the foreground claim');
  });
  await t.test('REQ-MEM-035: claim is held during asynchronous initialization and all stock shutdown writes', { timeout: 5000 }, async t => {
    const f = fixture(t), first = host(f), next = host(f), registry = {};
    const startup = deferred(), starting = deferred(), draining = deferred(), finish = deferred();
    const pending = attachHermesMemoryToForeground(registry, first.pi, async api => {
      starting.resolve();
      await startup.promise;
      api.on('session_shutdown', async () => {
        draining.resolve();
        await finish.promise;
        fs.writeFileSync(f.paths.user, 'Final foreground capture');
      });
      api.on('session_shutdown', () => fs.writeFileSync(f.paths.global, 'Stock database closed after capture'));
    });
    await starting.promise;
    assert.equal(await attachHermesMemoryToForeground(registry, next.pi, () => {}), false);
    startup.resolve();
    assert.equal(await pending, true);
    const shutdown = first.emit('session_shutdown', { reason: 'quit' });
    await draining.promise;
    assert.equal(await attachHermesMemoryToForeground(registry, next.pi, () => {}), false,
      'no new writer while the stock flush still owns files');
    finish.resolve();
    await shutdown;
    assert.equal(fs.readFileSync(f.paths.user, 'utf8'), 'Final foreground capture');
    assert.equal(fs.readFileSync(f.paths.global, 'utf8'), 'Stock database closed after capture');
    assert.equal(await attachHermesMemoryToForeground(registry, next.pi, api => {
      api.registerTool({ name: 'after_restart', execute: async () => ({
        content: [{ type: 'text', text: fs.readFileSync(f.paths.user, 'utf8') }],
      }) });
    }), true);
    assert.equal((await next.tools.get('after_restart').execute()).content[0].text, 'Final foreground capture');
  });
  await t.test('REQ-MEM-035: failed initializer reports failure and permits a later successful activation', async t => {
    const f = fixture(t), registry = {}, failed = host(f), recovered = host(f);
    await assert.rejects(attachHermesMemoryToForeground(registry, failed.pi, async () => {
      throw new Error('upstream package unavailable');
    }), /upstream package unavailable/);
    assert.equal(await attachHermesMemoryToForeground(registry, recovered.pi, api => {
      api.registerTool({ name: 'recovered_memory_read', execute: async () => ({
        content: [{ type: 'text', text: fs.readFileSync(f.paths.user, 'utf8') }],
      }) });
    }), true);
    assert.equal((await recovered.tools.get('recovered_memory_read').execute()).content[0].text, 'User prefers concise replies.');
  });
});

// The retired request reader used to own file-type/EACCES checks. Keep the
// applicable fail-closed boundary on managed activation, not on deleted framing.
test('REQ-MEM-035: unsafe or unreadable managed layout fails closed without exposing memory or registering writers', async t => {
  for (const kind of ['directory', 'symlink', 'dangling symlink', 'directory alias', 'malformed configuration', 'unreadable configuration']) {
    await t.test(kind, async t => {
      const f = fixture(t, { user: 'PRIVATE_PROFILE_CANARY', global: 'PRIVATE_GLOBAL_CANARY', workspace: 'PRIVATE_WORKSPACE_CANARY' }, '/tmp');
      const cache = join(f.root, '.cache/pi-hermes-memory'), agentDir = join(f.root, '.pi/agent');
      const vault = join(f.root, 'Vault');
      fs.mkdirSync(vault);
      fs.renameSync(f.memoryDir, join(vault, 'Memory'));
      const work = join(vault, 'Memory/Sessions/hermesfixture');
      const runtimeRoot = join(f.root, 'runtime');
      fs.mkdirSync(join(runtimeRoot, 'sync'), { recursive: true });
      fs.writeFileSync(join(runtimeRoot, 'sync/hermes-ready'), 'direct:hermesfixture\n');
      const memoryDir = join(work, 'global');
      const masters = join(vault, 'Memory');
      fs.mkdirSync(memoryDir, { recursive: true });
      fs.mkdirSync(join(agentDir, 'pi-hermes-memory'), { recursive: true });
      fs.mkdirSync(join(cache, 'consolidation-locks'), { recursive: true });
      fs.mkdirSync(join(cache, 'owners'));
      for (const name of ['USER.md', 'MEMORY.md', 'failures.md']) fs.copyFileSync(join(masters, name), join(memoryDir, name));
      fs.cpSync(join(masters, 'Projects'), join(work, 'Projects'), { recursive: true });
      fs.symlinkSync(join(work, 'Projects'), join(agentDir, 'hermes-project-memory'));
      fs.writeFileSync(join(work, 'session-id'), 'hermesfixture\n');
      const configPath = join(agentDir, 'hermes-memory-config.json');
      fs.writeFileSync(configPath, JSON.stringify({ memoryDir, projectsMemoryDir: 'hermes-project-memory', memoryMode: 'policy-only', lazyInitialization: true }));
      const outside = join(f.root, 'private-target.md');
      fs.writeFileSync(outside, 'DO_NOT_FOLLOW_PRIVATE_TARGET');
      const userPath = join(memoryDir, 'USER.md');
      if (['directory', 'symlink', 'dangling symlink'].includes(kind)) {
        fs.unlinkSync(userPath);
        if (kind === 'directory') fs.mkdirSync(userPath);
        else fs.symlinkSync(kind === 'symlink' ? outside : join(f.root, 'missing-target'), userPath);
      } else if (kind === 'directory alias') {
        const alias = join(f.root, 'aliased-cache');
        fs.renameSync(memoryDir, alias);
        fs.symlinkSync(alias, memoryDir);
      } else if (kind === 'malformed configuration') {
        fs.writeFileSync(configPath, '{"PRIVATE_CONFIGURATION_CANARY":');
      } else {
        // The image can run tests as root. Drop privilege only after loading the
        // adapter so this is real EACCES, not a mocked permission error.
        for (const path of [f.root, join(f.root, '.pi'), agentDir, vault, masters, join(masters, 'Sessions'), memoryDir, join(f.root, '.cache'), cache, work, join(work, 'Projects'), join(work, 'Projects/workspace')]) fs.chmodSync(path, 0o755);
        fs.chmodSync(configPath, 0o000);
      }
      const childScript = `
        import { importPiExtension } from ${JSON.stringify(new URL('./fixtures/pi-extension-module.mjs', import.meta.url).href)};
        const { default: initialize } = await importPiExtension('hermes-memory-runtime');
        if (${kind === 'unreadable configuration'} && process.getuid() === 0) {
          process.setgroups([]); process.setgid(65534); process.setuid(65534);
        }
        const tools = [], messages = [];
        await initialize({ on() {}, registerTool(tool) { tools.push(tool.name); }, sendMessage(message) { messages.push(message); } });
        console.log(JSON.stringify({ tools, messages }));
      `;
      const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
        env: { HOME: f.root, PI_CODING_AGENT_DIR: agentDir, SESSION_ID: 'hermesfixture', PATH: join(f.root, 'no-executables'),
          CODEFLARE_RUNTIME_ROOT: runtimeRoot, CODEFLARE_HERMES_PERSISTENCE: 'new' },
        stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      assert.equal(code, 0, stderr);
      assert.deepEqual(JSON.parse(stdout.trim()), { tools: [], messages: [] });
      assert.match(stderr, /memory unavailable/i, 'activation failure is visible, not successful empty memory');
      assert.ok(stderr.length < 2000, 'failure diagnostic stays bounded');
      for (const value of ['PRIVATE_PROFILE_CANARY', 'PRIVATE_GLOBAL_CANARY', 'PRIVATE_CONFIGURATION_CANARY', 'DO_NOT_FOLLOW_PRIVATE_TARGET']) assert.ok(!stderr.includes(value));
      assert.equal(fs.readFileSync(outside, 'utf8'), 'DO_NOT_FOLLOW_PRIVATE_TARGET');
      assert.equal(fs.readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8'), 'PRIVATE_GLOBAL_CANARY');
      if (kind === 'unreadable configuration') fs.chmodSync(configPath, 0o600);
    });
  }
});
