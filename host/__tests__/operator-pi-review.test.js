/** REQ-OPERATOR-021: parent-composed Pi filesystem sandbox. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createOperatorPiService } from '../dist/operator-pi-service.js';

const packetDigest = 'a'.repeat(64);
const head = 'b'.repeat(40);
const lanes = ['code-reviewer', 'spec-reviewer', 'doc-updater'];
const readable = [
  'review/input.json',
  ...lanes.map(lane => `review/packets/${lane}.json`),
  'review/resources/parent.md',
  ...lanes.map(lane => `review/resources/${lane}.md`),
];

function report(lane, overrides = {}) {
  return JSON.stringify({ schemaVersion: 1, lane, packetDigest, head, generation: 7,
    complete: true, omissions: [], findings: [], ...overrides });
}

async function fixture(t, configOverrides = {}) {
  const allowedRoot = await mkdtemp(path.join(tmpdir(), 'operator-pi-review-'));
  t.after(() => rm(allowedRoot, { recursive: true, force: true }));
  const root = path.join(allowedRoot, 'activity-1');
  const cwd = path.join(root, 'work');
  await mkdir(cwd, { recursive: true });
  for (const relative of readable) {
    await mkdir(path.dirname(path.join(cwd, relative)), { recursive: true });
    await writeFile(path.join(cwd, relative), `approved:${relative}`, 'utf8');
  }
  await mkdir(path.join(root, 'agent'), { recursive: true });
  await writeFile(path.join(root, 'agent/auth.json'), '{"secret":"credential"}', 'utf8');
  await mkdir(path.join(cwd, 'src'), { recursive: true });
  await writeFile(path.join(cwd, 'src/candidate.ts'), 'candidate source', 'utf8');

  let sessionOptions;
  const sdk = {
    ModelRuntime: { create: async () => ({ getModel: () => ({ provider: 'anthropic', id: 'approved' }) }) },
    SettingsManager: { inMemory: value => value },
    SessionManager: { create: () => ({}), open: () => ({}) },
    createExtensionRuntime: () => ({}),
    createReadToolDefinition: (toolCwd, options) => ({
      name: 'read', parameters: {},
      execute: async (_id, args) => {
        const absolute = path.resolve(toolCwd, args.path);
        await options.operations.access(absolute);
        const bytes = await options.operations.readFile(absolute);
        return { content: [{ type: 'text', text: bytes.toString('utf8') }], details: undefined };
      },
    }),
    createWriteToolDefinition: (toolCwd, options) => ({
      name: 'write', parameters: {},
      execute: async (_id, args) => {
        const absolute = path.resolve(toolCwd, args.path);
        await options.operations.mkdir(path.dirname(absolute));
        await options.operations.writeFile(absolute, args.content);
        return { content: [{ type: 'text', text: `Successfully wrote to ${args.path}` }], details: undefined };
      },
    }),
    createAgentSession: async options => {
      sessionOptions = options;
      return { session: {
        sessionId: 'pi-review', sessionFile: path.join(root, 'sessions/pi-review.jsonl'), isStreaming: false,
        agent: { state: { tools: options.customTools ?? [] } },
        prompt: async () => {}, followUp: async () => {}, steer: async () => {}, abort: async () => {},
        subscribe: () => () => {}, dispose() {},
      } };
    },
  };
  const config = { schemaVersion: 1, activityId: 'activity-1', sessionId: 'session-1', root,
    profile: { provider: 'anthropic', model: 'approved', thinkingLevel: 'off',
      systemPrompt: 'Approved Review parent', tools: ['read', 'write', 'bash'] },
    mode: 'review', review: { packetDigest, head, generation: 7 }, ...configOverrides };
  const piAi = { validateToolArguments: (_tool, call) => call.arguments };
  const service = createOperatorPiService({ serializedConfig: JSON.stringify(config), allowedRoot,
    importSdk: async () => sdk, importPiAi: async () => piAi });
  assert.ok(service);
  const response = await service.handle({ method: 'POST', pathname: '/internal/operator/pi/ensure',
    body: new TextEncoder().encode('{}') });
  assert.equal(response.status, 200);
  const tool = name => {
    const matches = sessionOptions.customTools.filter(candidate => candidate.name === name);
    assert.equal(matches.length, 1);
    return matches[0];
  };
  const invoke = (name, arguments_) => tool(name).execute('call-1', arguments_, new AbortController().signal);
  return { root, cwd, service, sessionOptions, invoke };
}

test('REQ-OPERATOR-021: Review composition exposes only fixed sandboxed read and write tools', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.sessionOptions.tools, ['read', 'write']);
  assert.deepEqual(f.sessionOptions.customTools.map(tool => tool.name), ['read', 'write']);
  assert.deepEqual(f.sessionOptions.resourceLoader.getExtensions().extensions, []);
  assert.deepEqual(f.sessionOptions.resourceLoader.getSkills().skills, []);
  assert.deepEqual(f.sessionOptions.resourceLoader.getPrompts().prompts, []);
  assert.deepEqual(f.sessionOptions.resourceLoader.getAgentsFiles().agentsFiles, []);
  assert.equal(f.sessionOptions.cwd, f.cwd);

  for (const relative of readable) {
    const result = await f.invoke('read', { path: relative });
    assert.equal(result.content[0].text, `approved:${relative}`);
  }
});

test('REQ-OPERATOR-021: Review reads deny absolute, traversal, symlink, undeclared, source and credential paths', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside.txt');
  await writeFile(outside, 'outside', 'utf8');
  await rm(path.join(f.cwd, 'review/input.json'));
  await symlink(outside, path.join(f.cwd, 'review/input.json'));

  const denied = [
    path.join(f.cwd, 'review/packets/code-reviewer.json'),
    'review/packets/../input.json',
    'review/input.json',
    'review/packets/extra.json',
    'review/resources/extra.md',
    'src/candidate.ts',
    '../agent/auth.json',
  ];
  for (const candidate of denied) {
    await assert.rejects(f.invoke('read', { path: candidate }), /review.*read.*denied/i, candidate);
  }
});

test('REQ-OPERATOR-021: Review writes only bound valid UTF-8 JSON lane reports', async t => {
  const f = await fixture(t);
  for (const lane of lanes) {
    const content = report(lane);
    await f.invoke('write', { path: `reports/${lane}.json`, content });
    assert.equal(await readFile(path.join(f.cwd, `reports/${lane}.json`), 'utf8'), content);
  }

  const invalid = [
    ['reports/code-reviewer.json', '{'],
    ['reports/code-reviewer.json', report('spec-reviewer')],
    ['reports/code-reviewer.json', report('code-reviewer', { packetDigest: 'c'.repeat(64) })],
    ['reports/code-reviewer.json', report('code-reviewer', { head: 'd'.repeat(40) })],
    ['reports/code-reviewer.json', report('code-reviewer', { generation: 8 })],
    ['reports/code-reviewer.json', `${report('code-reviewer')}\ud800`],
    ['reports/code-reviewer.json', JSON.stringify({ lane: 'code-reviewer', padding: 'x'.repeat(65 * 1024) })],
  ];
  for (const [destination, content] of invalid) {
    await assert.rejects(f.invoke('write', { path: destination, content }), /review.*report.*invalid/i);
  }
});

test('REQ-OPERATOR-021: Review writes deny all non-report, absolute, traversal and symlink destinations', async t => {
  const f = await fixture(t);
  const valid = report('code-reviewer');
  const outside = path.join(f.root, 'outside.json');
  await writeFile(outside, 'preserve', 'utf8');
  await mkdir(path.join(f.cwd, 'reports'), { recursive: true });
  await symlink(outside, path.join(f.cwd, 'reports/code-reviewer.json'));

  const denied = [
    path.join(f.cwd, 'reports/spec-reviewer.json'),
    'reports/../review/input.json',
    'reports/extra.json',
    'review/input.json',
    'src/candidate.ts',
    'reports/code-reviewer.json',
  ];
  for (const destination of denied) {
    const lane = destination.includes('spec-reviewer') ? 'spec-reviewer' : 'code-reviewer';
    await assert.rejects(f.invoke('write', { path: destination, content: report(lane) }), /review.*write.*denied/i, destination);
  }
  assert.equal(await readFile(outside, 'utf8'), 'preserve');
});

test('REQ-OPERATOR-021: Review report writes are atomic, same-byte idempotent and conflicting rewrites fail', async t => {
  const f = await fixture(t);
  const destination = 'reports/code-reviewer.json';
  const first = report('code-reviewer');
  await Promise.all([
    f.invoke('write', { path: destination, content: first }),
    f.invoke('write', { path: destination, content: first }),
  ]);
  assert.equal(await readFile(path.join(f.cwd, destination), 'utf8'), first);
  await assert.rejects(f.invoke('write', { path: destination,
    content: report('code-reviewer', { complete: false, omissions: ['incomplete'] }) }), /review.*report.*conflict/i);
  assert.equal(await readFile(path.join(f.cwd, destination), 'utf8'), first);
  assert.deepEqual((await readdir(path.join(f.cwd, 'reports'))).sort(), ['code-reviewer.json']);
});

test('REQ-OPERATOR-021: strict Review config validates parent bindings while the standard five-field config is unchanged', async t => {
  const f = await fixture(t);
  assert.ok(f.service);
  const base = { schemaVersion: 1, activityId: 'activity-1', sessionId: 'session-1', root: f.root,
    profile: { provider: 'anthropic', model: 'approved', thinkingLevel: 'off', systemPrompt: 'ordinary', tools: ['bash'] } };
  assert.ok(createOperatorPiService({ serializedConfig: JSON.stringify(base), allowedRoot: path.dirname(f.root),
    importSdk: async () => ({}), importPiAi: async () => ({}) }));

  const invalid = [
    { ...base, mode: 'review' },
    { ...base, mode: 'other', review: { packetDigest, head, generation: 7 } },
    { ...base, mode: 'review', review: { packetDigest: 'x'.repeat(64), head, generation: 7 } },
    { ...base, mode: 'review', review: { packetDigest, head: 'x'.repeat(40), generation: 7 } },
    { ...base, mode: 'review', review: { packetDigest, head, generation: 0 } },
    { ...base, mode: 'review', review: { packetDigest, head, generation: Number.MAX_SAFE_INTEGER + 1 } },
    { ...base, mode: 'review', review: { packetDigest, head, generation: 7, extra: true } },
    { ...base, mode: 'review', review: { packetDigest, head, generation: 7 }, extra: true },
  ];
  for (const value of invalid) {
    assert.throws(() => createOperatorPiService({ serializedConfig: JSON.stringify(value), allowedRoot: path.dirname(f.root) }),
      /configuration/i);
  }
});
