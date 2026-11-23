import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { patchPiSubagentsNotifications } from '../../scripts/patch-pi-subagents-notifications.mjs';

const capture = JSON.parse(readFileSync(new URL('../__fixtures__/pi-subagents-25.0.5-source.json', import.meta.url)));
const lock = JSON.parse(readFileSync(new URL('../../preseed/agents/pi/package-lock.json', import.meta.url)));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
let instance = 0;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-subagents-notifications-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, source] of Object.entries(capture.sources)) {
    assert.equal(sha256(source), capture.sourceSha256[path], 'authentic captured npm file digest contract');
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return root;
}

// Only unrelated composition-root dependencies are inert. The entrypoint,
// notification manager, formatting, usage and turn-budget code are authentic.
// The observer boundary exposes the same NotificationSystem the real lifecycle
// observer receives; no private manager fields or consumption methods are used.
const inertDependencies = `
export const boundary = {};
class Passive {
  load() {}
  add() {}
  handleTurnStart() {}
  handleSessionStart() {}
  handleSessionShutdown() {}
  toToolDefinition() { return { name: "unrelated-tool" }; }
}
export {
  Passive as AgentTypeRegistry, Passive as DefaultResourceLoader,
  Passive as InterruptHandler, Passive as WidgetEventsHandler,
  Passive as ConcurrencyLimiter, Passive as SubagentManager,
  Passive as CompositeSubagentObserver, Passive as SubagentsServiceAdapter,
  Passive as SettingsManager, Passive as ModelRegistry, Passive as ModelRuntime,
  Passive as SessionManager, Passive as AgentTool, Passive as GetResultTool,
  Passive as SteerTool, Passive as AgentWidget, Passive as SessionNavigatorHandler,
  Passive as SubagentsSettingsHandler,
};
export class SubagentEventsObserver {
  constructor({ notifications }) { boundary.notifications = notifications; }
}
export class SessionLifecycleHandler {
  constructor(_runtime, _manager, dispose) { this.dispose = dispose; }
  handleSessionShutdown() { this.dispose(); }
}
const noop = () => {};
export {
  noop as createAgentSession, noop as getAgentDir, noop as loadProjectContextFiles,
  noop as loadCustomAgents, noop as createChildLifecyclePublisher,
  noop as createSubagentSession, noop as createSubagentRuntime,
  noop as publishSubagentsService, noop as unpublishSubagentsService,
  noop as detectEnv, noop as resolveModel, noop as createExcludedPackagesStorage,
  noop as createProjectContextLoader, noop as buildAgentPrompt,
  noop as inheritRegisteredProviders, noop as deriveSubagentSessionDir,
  noop as createNotificationRenderer, noop as createUpdateRenderer,
  noop as createWorkspaceNoticeRenderer,
};
`;

async function host(t) {
  const root = fixture(t);
  patchPiSubagentsNotifications(root);
  const inertUrl = `${moduleUrl(inertDependencies)}#${instance++}`;
  const real = new Set([
    'src/index.ts', 'src/observation/notification.ts', 'src/observation/outcome-delivery.ts',
    'src/lifecycle/usage.ts', 'src/lifecycle/turn-limits.ts', 'src/debug.ts',
  ]);
  const modules = new Map();
  function url(path) {
    if (modules.has(path)) return modules.get(path);
    let source = transformSync(readFileSync(join(root, path), 'utf8'), {
      loader: 'ts', format: 'esm', target: 'es2022',
    }).code;
    source = source.replace(/from "(#src\/[^"]+|@earendil-works\/pi-coding-agent)"/g, (_match, specifier) => {
      const dependency = specifier.replace('#src/', 'src/') + '.ts';
      return `from "${real.has(dependency) ? url(dependency) : inertUrl}"`;
    });
    const result = moduleUrl(source);
    modules.set(path, result);
    return result;
  }
  const { default: register } = await import(url('src/index.ts'));
  const { boundary } = await import(inertUrl);
  const handlers = new Map();
  const sent = [];
  const model = [];
  const steer = [];
  const followUps = [];
  let active = false;
  // A host double of the documented public delivery contract, not a Pi SDK
  // integration test: steer precedes the next request, followUp waits for idle.
  register({
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerMessageRenderer() {}, registerTool() {}, registerCommand() {},
    events: { emit() {} },
    sendMessage(message, options) {
      sent.push({ message, options });
      if (!active) model.push(message);
      else if (options.deliverAs === 'steer') steer.push(message);
      else followUps.push(message);
    },
  });
  async function emit(event, payload = {}) {
    if (event === 'agent_start') active = true;
    if (event === 'agent_settled') active = false;
    for (const handler of handlers.get(event) ?? []) await handler(payload, {});
  }
  return {
    notifications: boundary.notifications, sent, followUps, emit,
    queueUserFollowUp(content) { followUps.push({ role: 'user', content }); },
    async toolBatch(...results) {
      model.push(...results.map(content => ({ role: 'toolResult', content })));
      await emit('turn_end', { outcome: 'completed', toolResults: results });
    },
    nextModelMessages() { model.push(...steer.splice(0)); return [...model]; },
  };
}

function record(id, overrides = {}) {
  return {
    id, description: `Task ${id}`, status: 'completed', result: `Result ${id}`,
    startedAt: 100, completedAt: 150, toolUses: 2,
    lifetimeUsage: { input: 10, output: 5, cacheWrite: 1 },
    claimed: false, consumed: false, runUpdates: [],
    getContextPercent() { return null; },
    isActive() { return this.status === 'running'; },
    markUpdateAnnounced(message) { this.runUpdates = this.runUpdates.filter(update => update !== message); },
    ...overrides,
  };
}
const announcements = messages => messages.filter(message => message.customType).map(message => ({
  type: message.customType, id: message.details.id, result: message.details.resultPreview,
}));
const completion = (id, result = `Result ${id}`) => ({ type: 'subagent-notification', id, result });

test('REQ-AGENT-053: queued parent follow-ups cannot starve completion past the next safe turn', async t => {
  const h = await host(t);
  await h.emit('agent_start');
  h.queueUserFollowUp('Already queued parent request');
  h.notifications.sendCompletion(record('native-result', { result: 'Finished <verified> & ready' }));
  assert.deepEqual(h.sent, [], 'no notification is handed off while tools are in flight');
  assert.deepEqual(h.nextModelMessages(), []);
  await h.toolBatch('first tool finished', 'last tool finished');
  const messages = h.nextModelMessages();
  assert.deepEqual(messages.slice(0, 2), [
    { role: 'toolResult', content: 'first tool finished' },
    { role: 'toolResult', content: 'last tool finished' },
  ]);
  assert.deepEqual(announcements(messages), [completion('native-result', 'Finished <verified> & ready')]);
  assert.match(messages.at(-1).content, /<task-id>native-result<\/task-id>/);
  assert.match(messages.at(-1).content, /<result>Finished &lt;verified&gt; &amp; ready<\/result>/,
    'native task-notification wire contract carries the escaped result into model context');
  assert.deepEqual(h.followUps, [{ role: 'user', content: 'Already queued parent request' }]);
  assert.deepEqual(h.sent.map(entry => entry.options), [{ deliverAs: 'steer', triggerTurn: true }],
    'public Pi delivery-mode contract: completion reaches the next request, not the idle queue');
});

test('REQ-AGENT-059 AC1: native retrieval delivers findings beyond the completion preview', {
  skip: process.env.GITHUB_ACTIONS !== 'true', // Host CI provisions the locked preseed packages.
}, async t => {
  const h = await host(t);
  const result = `${'First verified finding.\n'.repeat(40)}Final finding: retain the original receipt.`;
  const reviewer = record('reviewer-with-long-report', { type: 'doc-updater', result });
  h.notifications.sendCompletion(reviewer);
  const [preview] = h.nextModelMessages();
  assert.equal(preview.details.id, reviewer.id);
  assert.match(preview.content, /truncated, use get_subagent_result/);
  assert.doesNotMatch(preview.content, /Final finding/);

  const { createJiti } = createRequire(import.meta.url)('jiti');
  const jiti = createJiti(import.meta.url, { fsCache: false });
  const source = fileURLToPath(new URL('../../preseed/agents/pi/node_modules/@gotgenes/pi-subagents/src/tools/get-result-tool.ts', import.meta.url));
  const { GetResultTool } = await jiti.import(source);
  const finished = { ...reviewer, latestRun: { ...reviewer, markConsumed() {} } };
  const tool = new GetResultTool({ getRecord: id => id === reviewer.id ? finished : undefined }, {
    resolveAgentConfig: name => ({ name }),
  }).toToolDefinition();
  const report = await tool.execute('retrieve-review', { agent_id: preview.details.id }, new AbortController().signal);
  assert.equal(report.details.agentId, reviewer.id);
  assert.equal(report.details.status, 'completed');
  assert.ok(report.content[0].text.includes(result), 'the parent receives the intact findings, not just the preview');
});

test('Task118: result consumed by a tool in the same batch is not announced', async t => {
  const h = await host(t), result = record('pulled');
  await h.emit('agent_start');
  h.notifications.sendCompletion(result);
  result.consumed = true;
  await h.toolBatch('Tool returned the full pulled result');
  await h.emit('turn_end');
  await h.emit('agent_settled');
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.nextModelMessages(), [{ role: 'toolResult', content: 'Tool returned the full pulled result' }]);
});

test('Task118: repeated turn and settled boundaries announce each queued fact once and keep the run active', async t => {
  const h = await host(t);
  await h.emit('agent_start');
  h.notifications.sendCompletion(record('first'));
  await h.toolBatch('batch one');
  await h.emit('turn_end');
  // No new agent_start: a turn boundary must not release the mid-tool latch.
  h.notifications.sendCompletion(record('second'));
  assert.deepEqual(announcements(h.nextModelMessages()), [completion('first')]);
  await h.toolBatch('batch two');
  await h.emit('turn_end');
  await h.emit('agent_settled');
  await h.emit('agent_settled');
  assert.deepEqual(announcements(h.nextModelMessages()), [completion('first'), completion('second')]);
  assert.deepEqual(h.sent.map(entry => entry.options.deliverAs), ['steer', 'steer']);
});

test('Task118: multiple completions retain arrival order and same-agent coalescing', async t => {
  const h = await host(t);
  await h.emit('agent_start');
  h.notifications.sendCompletion(record('a', { result: 'superseded' }));
  h.notifications.sendCompletion(record('b'));
  h.notifications.sendCompletion(record('a', { result: 'latest' }));
  h.notifications.sendCompletion(record('c'));
  await h.toolBatch('tools done');
  await h.emit('agent_settled');
  assert.deepEqual(announcements(h.nextModelMessages()), [completion('a', 'latest'), completion('b'), completion('c')]);
});

test('Task118: claimed and consumed outcomes are suppressed both at enqueue and at flush', async t => {
  const h = await host(t);
  await h.emit('agent_start');
  const claimedAtEnqueue = record('claimed-enqueue', { claimed: true });
  const consumedAtEnqueue = record('consumed-enqueue', { consumed: true });
  h.notifications.sendCompletion(claimedAtEnqueue);
  h.notifications.sendCompletion(consumedAtEnqueue);
  claimedAtEnqueue.claimed = false;
  consumedAtEnqueue.consumed = false;
  const claimedAtFlush = record('claimed-flush'), consumedAtFlush = record('consumed-flush');
  h.notifications.sendCompletion(claimedAtFlush);
  h.notifications.sendCompletion(consumedAtFlush);
  claimedAtFlush.claimed = true;
  consumedAtFlush.consumed = true;
  await h.toolBatch('carrier returned owned outcomes');
  await h.emit('agent_settled');
  assert.deepEqual(h.sent, []);
});

test('Task118: settled fallback and already-idle completion retain followUp delivery', async t => {
  const h = await host(t);
  await h.emit('agent_start');
  h.notifications.sendCompletion(record('aborted-run'));
  await h.emit('agent_settled', { aborted: true });
  h.notifications.sendCompletion(record('idle'));
  await h.emit('turn_end');
  assert.deepEqual(announcements(h.nextModelMessages()), [completion('aborted-run'), completion('idle')]);
  assert.deepEqual(h.sent.map(entry => entry.options), [
    { deliverAs: 'followUp', triggerTurn: true }, { deliverAs: 'followUp', triggerTurn: true },
  ]);
});

for (const outcome of ['aborted', 'error']) {
  test(`REQ-AGENT-053: ${outcome} turn retains completion and update for settled fallback`, async t => {
    const h = await host(t);
    const running = record('running', { status: 'running', runUpdates: ['still relevant'] });
    await h.emit('agent_start');
    h.notifications.sendCompletion(record('finished'));
    h.notifications.sendUpdate(running, 'still relevant');
    await h.emit('turn_end', { outcome, toolResults: [] });
    assert.deepEqual(h.sent, [], 'an interrupted turn must not strand outcomes in steering');
    assert.deepEqual(running.runUpdates, ['still relevant']);
    await h.emit('agent_settled', { aborted: outcome === 'aborted' });
    const messages = h.nextModelMessages();
    assert.deepEqual(announcements(messages).map(({ type, id }) => ({ type, id })), [
      { type: 'subagent-notification', id: 'finished' },
      { type: 'subagent-update', id: 'running' },
    ]);
    assert.deepEqual(h.sent.map(({ options }) => options), [
      { deliverAs: 'followUp', triggerTurn: true },
      { deliverAs: 'followUp', triggerTurn: true },
    ]);
    assert.deepEqual(running.runUpdates, []);
    await h.emit('agent_settled');
    await h.emit('turn_end', { outcome: 'completed', toolResults: [] });
    assert.deepEqual(h.nextModelMessages(), messages, 'fallback delivers once without a new user prompt');
  });
}

test('Task118: live updates stay ordered and distinct while stale/claimed updates are suppressed', async t => {
  const h = await host(t);
  const running = record('running', { status: 'running', runUpdates: ['one', 'two'] });
  const terminated = record('terminated', { status: 'running' });
  const claimed = record('claimed', { status: 'running' });
  await h.emit('agent_start');
  h.notifications.sendUpdate(running, 'one');
  h.notifications.sendCompletion(record('done'));
  h.notifications.sendUpdate(running, 'two');
  h.notifications.sendUpdate(terminated, 'stale');
  h.notifications.sendUpdate(claimed, 'owned');
  terminated.status = 'completed';
  claimed.claimed = true;
  assert.deepEqual(h.sent, []);
  await h.toolBatch('tools finished');
  await h.emit('agent_settled');
  assert.deepEqual(h.sent.map(({ message }) => ({ type: message.customType, id: message.details.id, update: message.details.message })), [
    { type: 'subagent-update', id: 'running', update: 'one' },
    { type: 'subagent-notification', id: 'done', update: undefined },
    { type: 'subagent-update', id: 'running', update: 'two' },
  ]);
  assert.deepEqual(h.sent.map(entry => entry.options.deliverAs), ['steer', 'steer', 'steer']);
  assert.deepEqual(running.runUpdates, []);
});

test('Task118: shutdown discards queued announcements and remains silent afterwards', async t => {
  const h = await host(t), running = record('running', { status: 'running' });
  await h.emit('agent_start');
  h.notifications.sendCompletion(record('pending'));
  h.notifications.sendUpdate(running, 'pending update');
  await h.emit('session_shutdown');
  h.notifications.sendCompletion(record('shutdown-abort'));
  h.notifications.sendUpdate(running, 'late update');
  h.notifications.sendWorkspaceNotice(running, 'late workspace notice');
  await h.emit('turn_end');
  await h.emit('agent_settled');
  await h.emit('agent_start');
  h.notifications.sendCompletion(record('after-shutdown'));
  await h.emit('turn_end');
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.nextModelMessages(), []);
});

test('Task118: authentic capture matches the committed npm identity and archive-integrity contract', () => {
  const installed = lock.packages['node_modules/@gotgenes/pi-subagents'];
  assert.deepEqual(capture.origin, {
    name: '@gotgenes/pi-subagents', version: installed.version,
    resolved: installed.resolved, integrity: installed.integrity,
  });
  const manifest = JSON.parse(capture.sources['package.json']);
  assert.equal(manifest.name, capture.origin.name);
  assert.equal(manifest.version, capture.origin.version);
});

test('Task118: image PREPARE is byte-idempotent and does not rewrite pristine package metadata or support files', t => {
  const root = fixture(t);
  patchPiSubagentsNotifications(root);
  const prepared = Object.fromEntries(Object.keys(capture.sources).map(path => [path, readFileSync(join(root, path))]));
  patchPiSubagentsNotifications(root);
  for (const [path, bytes] of Object.entries(prepared)) {
    assert.deepEqual(readFileSync(join(root, path)), bytes, 'exact prepared artifact contract on repeat');
    if (!['src/index.ts', 'src/observation/notification.ts'].includes(path)) {
      assert.equal(bytes.toString(), capture.sources[path], 'untouched upstream artifact contract');
    }
  }
});

for (const drift of ['name', 'version', 'manifest', 'index', 'notification', 'prepared', 'symlink']) {
  test(`Task118: PREPARE rejects ${drift} drift without partially modifying the package`, t => {
    const root = fixture(t);
    let path = 'package.json';
    if (drift === 'name' || drift === 'version') {
      const manifest = JSON.parse(capture.sources[path]);
      manifest[drift] = drift === 'name' ? 'unrelated-package' : '25.0.6';
      writeFileSync(join(root, path), JSON.stringify(manifest));
    } else if (drift === 'symlink') {
      path = 'src/observation/notification.ts';
      const outside = join(root, 'untouched-notification.ts');
      writeFileSync(outside, capture.sources[path]);
      rmSync(join(root, path));
      symlinkSync(outside, join(root, path));
    } else {
      if (drift === 'prepared') patchPiSubagentsNotifications(root);
      if (drift === 'index') path = 'src/index.ts';
      if (drift === 'notification' || drift === 'prepared') path = 'src/observation/notification.ts';
      writeFileSync(join(root, path), readFileSync(join(root, path), 'utf8') + '\n// unreviewed drift\n');
    }
    const before = Object.fromEntries(Object.keys(capture.sources).map(file => [file, readFileSync(join(root, file))]));
    assert.throws(() => patchPiSubagentsNotifications(root));
    for (const [file, bytes] of Object.entries(before)) {
      assert.deepEqual(readFileSync(join(root, file)), bytes, 'fail-closed no-partial-write artifact contract');
    }
  });
}
