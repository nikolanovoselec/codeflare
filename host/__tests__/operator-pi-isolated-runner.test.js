import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createOperatorPiService } from '../dist/operator-pi-service.js';

const lanes = ['code-reviewer', 'spec-reviewer', 'doc-updater'];
const init = { schemaVersion: 1, profileId: 'approved-review', contextPath: 'review/input.json',
  context: JSON.stringify({ packetDigest: 'a'.repeat(64), head: 'b'.repeat(40), generation: 7 }),
  inputs: [
    { kind: 'resource', reference: 'review/parent.md', target: 'review/resources/parent.md' },
    ...lanes.map(lane => ({ kind: 'resource', reference: `review/${lane}.md`, target: `review/resources/${lane}.md` })),
    ...lanes.map(lane => ({ kind: 'attachment', reference: `packet-${lane}.json`, target: `review/packets/${lane}.json` })),
  ], tasks: lanes.map(lane => ({ id: lane, instruction: `review/resources/${lane}.md`,
    reads: ['review/input.json', `review/packets/${lane}.json`, `review/resources/${lane}.md`],
    output: `reports/${lane}.json` })) };
const taskArgs = { initializationDigest: createHash('sha256').update(JSON.stringify(init)).digest('hex') };
const report = lane => JSON.stringify({ schemaVersion: 1, lane, packetDigest: 'a'.repeat(64), head: 'b'.repeat(40),
  generation: 7, complete: true, omissions: [], findings: [] });

async function fixture(t, configOverrides = {}, behavior = {}) {
  const allowedRoot = await mkdtemp(path.join(tmpdir(), 'operator-pi-isolated-'));
  t.after(() => rm(allowedRoot, { recursive: true, force: true }));
  const root = path.join(allowedRoot, 'activity-1');
  const cwd = path.join(root, 'work');
  const outputRoot = path.join(root, 'output');
  await mkdir(cwd, { recursive: true });
  await mkdir(outputRoot);
  for (const relative of [init.contextPath, ...init.inputs.map(input => input.target)]) {
    await mkdir(path.dirname(path.join(cwd, relative)), { recursive: true });
    await writeFile(path.join(cwd, relative), `approved:${relative}`);
  }
  await mkdir(path.join(root, 'agent'));
  await writeFile(path.join(root, 'agent/auth.json'), '{"secret":"credential"}');
  await mkdir(path.join(cwd, 'src'));
  await writeFile(path.join(cwd, 'src/candidate.ts'), 'candidate source');
  const childSessions = [];
  const abortedChildren = new Set();
  let rootOptions;
  const sdk = {
    ModelRuntime: { create: async () => ({ getModel: () => ({ provider: 'anthropic', id: 'approved' }) }) },
    SettingsManager: { inMemory: value => value },
    SessionManager: { create: (_cwd, dir) => ({ dir }), open: (file, dir, cwdOverride) => {
      if (statSync(file).size === 0) writeFileSync(file,
        JSON.stringify({ type: 'session', id: 'pi-root', cwd: cwdOverride }));
      return { dir, file };
    } },
    createExtensionRuntime: () => ({}),
    createReadToolDefinition: (toolCwd, options) => ({ name: 'read', parameters: {},
      execute: async (_id, args) => {
        const absolute = path.resolve(toolCwd, args.path);
        await options.operations.access(absolute);
        return { content: [{ type: 'text', text: (await options.operations.readFile(absolute)).toString('utf8') }] };
      } }),
    createWriteToolDefinition: (toolCwd, options) => ({ name: 'write', parameters: {},
      execute: async (_id, args) => {
        const absolute = path.resolve(toolCwd, args.path);
        await options.operations.mkdir(path.dirname(absolute));
        await options.operations.writeFile(absolute, args.content);
        return { content: [{ type: 'text', text: 'written' }] };
      } }),
    createAgentSession: async options => {
      const lane = lanes.find(value => options.sessionManager.dir.endsWith(`approved-${value}`));
      if (lane && behavior.createSession) await behavior.createSession(lane);
      if (lane) childSessions.push({ lane, options });
      else rootOptions = options;
      const listeners = new Set();
      return { session: {
        sessionId: lane ?? 'pi-root', sessionFile: options.sessionManager.file
          ?? path.join(options.sessionManager.dir, `${lane ?? 'pi-root'}.jsonl`),
        isStreaming: false, agent: { state: { tools: options.customTools ?? [] } },
        prompt: async () => {
          if (!lane) throw new Error('Root cannot impersonate an approved task');
          if (behavior.prompt) await behavior.prompt({ lane, options });
          else await options.customTools.find(tool => tool.name === 'write').execute('report',
            { path: `reports/${lane}.json`, content: report(lane) });
          for (const listener of listeners) listener({ type: 'agent_settled' });
        }, followUp: async () => {}, steer: async () => {},
        abort: async () => { if (lane) abortedChildren.add(lane); },
        subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, dispose() {},
      } };
    },
  };
  const config = { schemaVersion: 1, activityId: 'activity-1', sessionId: 'session-1', root,
    profile: { provider: 'anthropic', model: 'approved', thinkingLevel: 'off', systemPrompt: 'Approved parent',
      tools: ['read', 'write'] }, mode: 'isolated', initialization: init,
    deadline: Date.now() + 60_000, ...configOverrides };
  const service = createOperatorPiService({ serializedConfig: JSON.stringify(config), allowedRoot,
    isolatedOutputRoot: outputRoot, importSdk: async () => sdk,
    importPiAi: async () => ({ validateToolArguments: (_tool, call) => call.arguments }) });
  assert.ok(service);
  assert.equal((await service.handle({ method: 'POST', pathname: '/internal/operator/pi/ensure',
    body: new TextEncoder().encode('{}') })).status, 200);
  assert.equal(JSON.parse(await readFile(path.join(root, 'sessions/approved-parent.jsonl'), 'utf8')).cwd, cwd,
    'Parent-mediated task identity must persist in its approved working directory');
  const invoke = (name, arguments_) => rootOptions.customTools.find(tool => tool.name === name)
    .execute('read-write', arguments_);
  return { service, root, cwd, outputRoot, rootOptions, childSessions, abortedChildren, invoke,
    config, allowedRoot, sdk };
}

async function submit(f, taskId, arguments_ = taskArgs) {
  const body = new TextEncoder().encode(JSON.stringify({ taskId, digest: 'c'.repeat(64), mode: 'tool',
    toolName: 'run_approved_tasks', arguments: arguments_ }));
  const send = () => f.service.handle({ method: 'POST', pathname: '/internal/operator/pi/tasks', body });
  assert.equal((await send()).status, 202);
  for (let i = 0; i < 1000; i++) {
    const { status } = JSON.parse((await send()).body);
    if (status !== 'running') return status;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Isolated task did not settle');
}

test('REQ-OPERATOR-021: isolated read/write tools expose only declared paths and immutable bounded outputs', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.rootOptions.tools, ['read', 'write']);
  assert.deepEqual(f.rootOptions.customTools.map(tool => tool.name), ['read', 'write']);
  assert.deepEqual(f.rootOptions.resourceLoader.getExtensions().extensions, []);
  const prompt = new TextEncoder().encode(JSON.stringify({ taskId: 'prompt-denied', digest: 'b'.repeat(64),
    mode: 'prompt', text: 'Read the host credentials' }));
  assert.equal((await f.service.handle({ method: 'POST', pathname: '/internal/operator/pi/tasks', body: prompt })).status, 202);
  for (let i = 0; i < 100; i++) {
    const observed = JSON.parse((await f.service.handle({ method: 'POST',
      pathname: '/internal/operator/pi/tasks', body: prompt })).body);
    if (observed.status === 'failed') break;
    if (i === 99) assert.fail('Isolated prompt was not rejected');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.deepEqual(f.childSessions, []);
  assert.equal((await f.invoke('read', { path: init.contextPath })).content[0].text, `approved:${init.contextPath}`);
  const outside = path.join(f.root, 'outside');
  await writeFile(outside, 'preserve');
  await rm(path.join(f.cwd, init.contextPath));
  await symlink(outside, path.join(f.cwd, init.contextPath));
  for (const candidate of [init.contextPath, '../agent/auth.json', 'src/candidate.ts',
    path.join(f.cwd, 'review/packets/code-reviewer.json'), 'review/packets/../input.json']) {
    await assert.rejects(f.invoke('read', { path: candidate }));
  }
  for (const candidate of ['../agent/auth.json', 'src/candidate.ts', 'reports/other.json',
    path.join(f.cwd, 'reports/code-reviewer.json')]) {
    await assert.rejects(f.invoke('write', { path: candidate, content: report('code-reviewer') }));
  }
  await assert.rejects(f.invoke('write', { path: 'reports/code-reviewer.json', content: '\ud800' }));
  await assert.rejects(f.invoke('write', { path: 'reports/code-reviewer.json', content: 'x'.repeat(65 * 1024) }));
  await Promise.all([f.invoke('write', { path: 'reports/code-reviewer.json', content: report('code-reviewer') }),
    f.invoke('write', { path: 'reports/code-reviewer.json', content: report('code-reviewer') })]);
  await assert.rejects(f.invoke('write', { path: 'reports/code-reviewer.json', content: report('spec-reviewer') }));
  assert.equal(await readFile(outside, 'utf8'), 'preserve');
  assert.deepEqual(await readdir(path.join(f.cwd, 'reports')), ['code-reviewer.json']);
});

test('REQ-OPERATOR-021: strict isolated config denies invalid references while standard config remains valid', async t => {
  const f = await fixture(t);
  const standard = { schemaVersion: 1, activityId: 'activity-1', sessionId: 'session-1', root: f.root,
    profile: { provider: 'anthropic', model: 'approved', thinkingLevel: 'off', systemPrompt: 'standard', tools: ['bash'] } };
  assert.ok(createOperatorPiService({ serializedConfig: JSON.stringify(standard), allowedRoot: path.dirname(f.root) }));
  for (const invalid of [
    { ...standard, mode: 'isolated' },
    { ...standard, mode: 'isolated', initialization: init, deadline: 'tomorrow' },
    { ...standard, mode: 'isolated', initialization: { ...init, tasks: [{ ...init.tasks[0],
      reads: ['../../.pi/agent/auth.json'] }] }, deadline: Date.now() + 60_000 },
    { ...standard, mode: 'isolated', initialization: { ...init, tasks: [init.tasks[0], init.tasks[0]] },
      deadline: Date.now() + 60_000 },
  ]) assert.throws(() => createOperatorPiService({ serializedConfig: JSON.stringify(invalid), allowedRoot: path.dirname(f.root) }));
});

test('REQ-OPERATOR-021: one structured task creates independently isolated SDK sessions and durable identities', async t => {
  const f = await fixture(t);
  assert.equal(await submit(f, 'approved-round'), 'completed');
  const persisted = JSON.parse(await readFile(path.join(f.root, '.codeflare/operator-pi.json')));
  assert.equal(persisted.tasks['approved-round'].status, 'completed');
  assert.deepEqual(f.childSessions.map(item => item.lane).sort(), [...lanes].sort());
  const journal = JSON.parse(await readFile(path.join(f.root, 'sessions/approved-children.json')));
  assert.equal(journal.taskId, 'approved-round');
  assert.deepEqual(journal.children.map(item => item.taskId).sort(), [...lanes].sort());
  for (const child of f.childSessions) {
    assert.deepEqual(child.options.resourceLoader.getExtensions().extensions, []);
    assert.deepEqual(await readFile(path.join(f.cwd, `reports/${child.lane}.json`)),
      await readFile(path.join(f.outputRoot, `reports/${child.lane}.json`)));
    const other = lanes.find(lane => lane !== child.lane);
    await assert.rejects(child.options.customTools.find(tool => tool.name === 'read')
      .execute('other', { path: `review/packets/${other}.json` }));
    await assert.rejects(child.options.customTools.find(tool => tool.name === 'write')
      .execute('other', { path: `reports/${other}.json`, content: report(other) }));
  }
  const restarted = createOperatorPiService({ serializedConfig: JSON.stringify(f.config),
    allowedRoot: f.allowedRoot, isolatedOutputRoot: f.outputRoot,
    importSdk: async () => f.sdk,
    importPiAi: async () => ({ validateToolArguments: (_tool, call) => call.arguments }) });
  assert.equal((await restarted.handle({ method: 'POST', pathname: '/internal/operator/pi/ensure',
    body: new TextEncoder().encode('{}') })).status, 200);
  assert.equal(await submit({ ...f, service: restarted }, 'replacement-after-restart'), 'failed');
  assert.equal(await submit(f, 'spoofed', { initializationDigest: 'e'.repeat(64) }), 'failed');
  assert.equal(await submit(f, 'replacement'), 'failed');
  assert.deepEqual(f.childSessions.map(item => item.lane).sort(), [...lanes].sort());
});

test('REQ-OPERATOR-021: a reopened SDK cannot replace the persisted root session identity', async t => {
  const f = await fixture(t);
  const substituted = { ...f.sdk, createAgentSession: async options => {
    const { session } = await f.sdk.createAgentSession(options);
    return { session: { ...session, sessionFile: path.join(f.root, 'sessions/substituted.jsonl') } };
  } };
  const restarted = createOperatorPiService({ serializedConfig: JSON.stringify(f.config),
    allowedRoot: f.allowedRoot, isolatedOutputRoot: f.outputRoot,
    importSdk: async () => substituted,
    importPiAi: async () => ({ validateToolArguments: (_tool, call) => call.arguments }) });
  assert.equal((await restarted.handle({ method: 'POST', pathname: '/internal/operator/pi/ensure',
    body: new TextEncoder().encode('{}') })).status, 500);
  const persisted = JSON.parse(await readFile(path.join(f.root, '.codeflare/operator-pi.json')));
  assert.equal(persisted.sessionFile, path.join(f.root, 'sessions/approved-parent.jsonl'));
});

test('REQ-OPERATOR-021: child prompts and staging use the parent-bound activity report paths', async t => {
  const scoped = { ...init, tasks: init.tasks.map(task => ({ ...task,
    output: `reports/activity-1-1-${task.id}.json` })) };
  const f = await fixture(t, { initialization: scoped }, { prompt: async ({ lane, options }) => {
    const output = scoped.tasks.find(task => task.id === lane).output;
    assert.ok(options.resourceLoader.getSystemPrompt().includes(output));
    await options.customTools.find(tool => tool.name === 'write').execute('report',
      { path: output, content: report(lane) });
    await assert.rejects(options.customTools.find(tool => tool.name === 'write').execute('wrong-output',
      { path: `reports/${lane}.json`, content: report(lane) }));
  } });
  const initializationDigest = createHash('sha256').update(JSON.stringify(scoped)).digest('hex');
  assert.equal(await submit(f, 'scoped-round', { initializationDigest }), 'completed');
  for (const task of scoped.tasks) {
    assert.equal(await readFile(path.join(f.outputRoot, task.output), 'utf8'), report(task.id));
    await assert.rejects(readFile(path.join(f.outputRoot, `reports/${task.id}.json`)));
  }
});

test('REQ-OPERATOR-021: deadline and sibling failure cannot publish partial output', async t => {
  const expired = await fixture(t, { deadline: Date.now() + 1_000 });
  await new Promise(resolve => setTimeout(resolve, 1_020));
  assert.equal(await submit(expired, 'expired'), 'failed');
  assert.deepEqual(expired.childSessions, []);
  const failing = await fixture(t, {}, { prompt: async ({ lane, options }) => {
    if (lane === 'code-reviewer') throw new Error('Model failed');
    await options.customTools.find(tool => tool.name === 'write').execute('report',
      { path: `reports/${lane}.json`, content: report(lane) });
  } });
  assert.equal(await submit(failing, 'failed-lane'), 'failed');
  assert.deepEqual([...failing.abortedChildren].sort(), [...lanes].sort());
  await assert.rejects(readFile(path.join(failing.outputRoot, 'reports/spec-reviewer.json')));
});

test('REQ-OPERATOR-021: cancellation during creation or after journal persistence aborts children', async t => {
  let started;
  const creating = new Promise(resolve => { started = resolve; });
  let release;
  const withheld = new Promise(resolve => { release = resolve; });
  const late = await fixture(t, {}, { createSession: async () => { started(); await withheld; } });
  const body = new TextEncoder().encode(JSON.stringify({ taskId: 'late', digest: 'c'.repeat(64), mode: 'tool',
    toolName: 'run_approved_tasks', arguments: taskArgs }));
  assert.equal((await late.service.handle({ method: 'POST', pathname: '/internal/operator/pi/tasks', body })).status, 202);
  await creating;
  const intent = JSON.parse(await readFile(path.join(late.root, 'sessions/approved-children.json')));
  assert.equal(intent.taskId, 'late');
  assert.deepEqual(intent.children, []);
  assert.equal(JSON.parse((await late.service.handle({ method: 'POST',
    pathname: '/internal/operator/pi/tasks/late/abort', body: new TextEncoder().encode('{}') })).body).status, 'cancelled');
  release();
  for (let i = 0; i < 200 && !late.abortedChildren.has('code-reviewer'); i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(late.abortedChildren.has('code-reviewer'), true);
  await assert.rejects(readFile(path.join(late.outputRoot, 'reports/code-reviewer.json')));

  const running = await fixture(t, {}, { prompt: async () => new Promise(() => {}) });
  const waiting = new TextEncoder().encode(JSON.stringify({ taskId: 'waiting', digest: 'c'.repeat(64), mode: 'tool',
    toolName: 'run_approved_tasks', arguments: taskArgs }));
  assert.equal((await running.service.handle({ method: 'POST', pathname: '/internal/operator/pi/tasks', body: waiting })).status, 202);
  let journal;
  for (let i = 0; i < 200; i++) {
    try { journal = JSON.parse(await readFile(path.join(running.root, 'sessions/approved-children.json'))); }
    catch { /* Creation may not have persisted intent yet. */ }
    if (journal?.children?.length === lanes.length) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(journal, 'Approved child journal was not persisted');
  assert.deepEqual(journal.children.map(child => child.taskId).sort(), [...lanes].sort());
  assert.equal(JSON.parse((await running.service.handle({ method: 'POST',
    pathname: '/internal/operator/pi/tasks/waiting/abort', body: new TextEncoder().encode('{}') })).body).status, 'cancelled');
  assert.deepEqual([...running.abortedChildren].sort(), [...lanes].sort());
  await assert.rejects(readFile(path.join(running.outputRoot, 'reports/code-reviewer.json')));
});
