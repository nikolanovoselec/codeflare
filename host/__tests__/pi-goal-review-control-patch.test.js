import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CONTROL_CHANNEL, patchPiGoalDirectory } from '../../scripts/patch-pi-goal-review-control.mjs';
import { patchPiPlanModeDirectory } from '../../scripts/patch-pi-plan-mode-tool-policy.mjs';

// Exercise exact registry captures, without reconstructing sources or installing dependencies.
const GOAL_FIXTURES = {
  '0.55.1': 'sha512-Bx+J9yk0gfb4+nis2FRvwYcMGBH10KN4HK9ebY/QhcU137LPGjrfqmy2lDse6Zm1qycTzZ4T+Jde/mzvPfH8EQ==',
  '0.55.5': 'sha512-rM3PzGFehFAF/6FD/JrN694G254uZqTaZIZwU8gtyPvBzoyTSGHwcBUKXfHbPGnoyBZ7BHdgD4LFlBJmzkd8nA==',
};
const LATEST = '0.55.5';

function unpack(t, fixture, integrity) {
  const archive = fileURLToPath(new URL(`../__fixtures__/${fixture}`, import.meta.url));
  assert.equal(`sha512-${createHash('sha512').update(readFileSync(archive)).digest('base64')}`, integrity);
  const root = mkdtempSync(join(tmpdir(), 'pi-goal-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('tar', ['-xzf', archive, '-C', root, '--strip-components=1']);
  return root;
}

function unpackGoal(t, version) {
  return unpack(t, `narumitw-pi-goal-${version}.tgz`, GOAL_FIXTURES[version]);
}

function prepareGoal(t, version) {
  const root = unpackGoal(t, version);
  patchPiGoalDirectory(version, root);
  return root;
}

function snapshot(root) {
  return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => {
      const file = join(entry.parentPath, entry.name);
      return [file.slice(root.length + 1), readFileSync(file)];
    }));
}

// Node loads the actual TypeScript fixture files. Only Pi/TUI boundary APIs
// are substituted; workflow scheduling and tool handlers run from the capture.
const PI_STUBS = `
export const DEFAULT_MAX_BYTES = 50_000;
export const DEFAULT_MAX_LINES = 2_000;
export const defineMenu = (definition) => definition;
export const defineTool = (definition) => definition;
export const getMarkdownTheme = () => ({});
export const isContextOverflow = (message) => message.errorMessage === 'input exceeds the context window';
export const isRetryableAssistantError = () => false;
export const runMenu = async () => ({ kind: "cancel" });
export const stripTerminalSequences = (value) => value;
// Fixture inputs contain no terminal controls; UI sanitation is an
// external boundary, not the workflow ownership behavior under test.
export const sanitizeTerminalText = (value) => value;
export const truncateHead = (content) => ({ content, truncated: false });
export const truncateToWidth = (value) => value;
export const visibleWidth = (value) => value.length;
export const sanitizeTerminalDocument = (value) => value;
export const hardWrapTerminalDocument = (value) => value.split('\\n');
export const getKeybindings = () => ({ getResolvedBindings: () => ({}) });
export const matchesKey = () => false;
export const isKeyRelease = () => false;
export const isKeyRepeat = () => false;
export const withFileMutationQueue = async (_path, operation) => operation();
export class Markdown {}
export class EditorStatusWidget {}
`;

async function loadFixture(t, root, entry) {
  const prefix = pathToFileURL(`${root}/`).href;
  const stubs = `${PI_STUBS}\nexport const getAgentDir = () => ${JSON.stringify(root)};`;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!context.parentURL?.startsWith(prefix)) return nextResolve(specifier, context);
      if (/^@(?:earendil-works\/pi-(?:ai|coding-agent|tui)|narumitw\/pi-tui-kit(?:\/[^/]+)?)$/.test(specifier)) {
        return { url: `data:text/javascript,${encodeURIComponent(stubs)}`, shortCircuit: true };
      }
      if (specifier === 'typebox') {
        const require = createRequire(import.meta.url);
        const candidates = require.resolve.paths('typebox');
        const path = require.resolve('typebox', { paths: [...candidates, '/opt/codeflare/npm-tools'] });
        return nextResolve(pathToFileURL(path).href, context);
      }
      return nextResolve(specifier.startsWith('.') && specifier.endsWith('.js')
        ? specifier.replace(/\.js$/, '.ts') : specifier, context);
    },
  });
  // Some commands import their UI modules only when invoked.
  t.after(() => hooks.deregister());
  return import(new URL(entry, prefix));
}

function createExtensionHarness() {
  const commands = new Map();
  const lifecycle = new Map();
  const eventListeners = new Map();
  const notifications = [];
  const statuses = new Map();
  const entries = [];
  const messages = [];
  const aborts = [];
  const tools = [
    { name: 'read', description: 'Read files', sourceInfo: { source: 'builtin' } },
    { name: 'bash', description: 'Run bounded commands', sourceInfo: { source: 'builtin' } },
    { name: 'edit', description: 'Edit files', sourceInfo: { source: 'builtin' } },
  ];
  let activeTools = [];
  let thinkingLevel = 'medium';
  const sessionManager = {
    getBranch: () => entries,
    getEntries: () => entries,
  };
  const ui = new Proxy({
    notify: (message, level) => notifications.push({ message, level }),
    setStatus: (key, text) => { if (text === undefined) statuses.delete(key); else statuses.set(key, text); },
  }, { get: (target, property) => target[property] ?? (() => undefined) });
  const api = new Proxy({
    events: {
      on(channel, listener) {
        const listeners = eventListeners.get(channel) ?? [];
        listeners.push(listener);
        eventListeners.set(channel, listeners);
        return () => eventListeners.set(channel, listeners.filter((candidate) => candidate !== listener));
      },
      emit(channel, payload) {
        return Promise.all((eventListeners.get(channel) ?? []).map((listener) => listener(payload)));
      },
    },
    registerCommand: (name, definition) => commands.set(name, definition),
    registerTool: (definition) => {
      tools.push({
        ...definition,
        sourceInfo: { source: 'extension', path: 'pinned-fixture' },
      });
      activeTools.push(definition.name);
    },
    registerFlag: () => undefined,
    getFlag: () => false,
    on(name, listener) {
      const listeners = lifecycle.get(name) ?? [];
      listeners.push(listener);
      lifecycle.set(name, listeners);
    },
    appendEntry(customType, data) {
      // Session persistence snapshots values; later runtime mutation must not
      // rewrite the previously persisted branch in this behavioral harness.
      entries.push({ type: 'custom', customType, data: structuredClone(data) });
    },
    sendUserMessage: async (content, options) => { messages.push({ content, options }); },
    sendMessage: (message) => { entries.push({ type: 'custom_message', ...message }); },
    getAllTools: () => [...tools],
    getActiveTools: () => [...activeTools],
    setActiveTools: (tools) => { activeTools = [...tools]; },
    getThinkingLevel: () => thinkingLevel,
    setThinkingLevel: (level) => { thinkingLevel = level; },
  }, { get: (target, property) => target[property] ?? (() => undefined) });
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    mode: 'interactive',
    sessionManager,
    ui,
    isIdle: () => true,
    abort: () => aborts.push(Date.now()),
    hasPendingMessages: () => false,
  };
  return {
    aborts,
    activeTools: () => activeTools,
    api,
    commands,
    ctx,
    emit: (channel, payload) => api.events.emit(channel, payload),
    entries,
    messages,
    notifications,
    statuses,
    tools,
    dispatch: async (name, event = {}) => {
      let result;
      for (const listener of lifecycle.get(name) ?? []) result = await listener(event, ctx) ?? result;
      return result;
    },
    startSession: async () => {
      for (const listener of lifecycle.get('session_start') ?? []) await listener({}, ctx);
    },
    runContext: async () => {
      let event = { messages: [] };
      for (const listener of lifecycle.get('context') ?? []) {
        event = await listener(event, ctx) ?? event;
      }
      return event;
    },
  };
}

// Behavioral driver uses only registered commands/tools, lifecycle events,
// persisted session state and delivered prompts, never runtime internals.
async function createStallScenario(t, version, limits = {}, preferences = {}) {
  const root = prepareGoal(t, version);
  const settingsPath = join(root, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ ...preferences, toolVisibility: 'after-first-goal', continuationLimits: {
    automaticTurns: null, noProgressTurns: null, minIntervalMs: 0, ...limits,
  } }));
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const { default: extension } = await loadFixture(t, root, manifest.pi.extensions[0]);
  const harness = createExtensionHarness();
  extension(harness.api, { settingsPath });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_800_000_000_000 });
  t.after(async () => {
    await harness.dispatch('session_shutdown');
    t.mock.timers.reset();
  });
  await harness.startSession();
  const state = () => harness.entries.filter(entry => entry.customType === 'goal-state').at(-1)?.data.goal;
  const tool = name => {
    const definition = harness.tools.find(candidate => candidate.name === name);
    assert.ok(definition, `${name} is registered`);
    return definition;
  };
  const report = (stateValue, evidence = 'Completed objective fixture preparation; inspected the resulting artifact.', goalId = state()?.id) =>
    tool('goal_progress').execute('progress', { goal_id: goalId, state: stateValue, evidence }, undefined, undefined, harness.ctx);
  const begin = async (prompt = harness.messages.shift()?.content) => {
    assert.equal(typeof prompt, 'string', 'a queued Goal prompt is delivered');
    await harness.dispatch('before_agent_start', { prompt, systemPrompt: '' });
    await harness.dispatch('agent_start');
  };
  const finish = async (text = 'External result is not available yet.', turns = 1, errorMessage, settle = true) => {
    const message = { role: 'assistant', content: [{ type: 'text', text }],
      stopReason: errorMessage ? 'error' : 'stop', ...(errorMessage ? { errorMessage } : {}) };
    for (let index = 0; index < turns; index++) await harness.dispatch('turn_end', { message, toolResults: [] });
    await harness.dispatch('agent_end', { messages: [message] });
    if (settle) await harness.dispatch('agent_settled');
  };
  const next = async () => {
    assert.equal(harness.messages.length, 0, 'no continuation arrives early');
    t.mock.timers.tick(299_999);
    assert.equal(harness.messages.length, 0, 'automatic attempts are at least five minutes apart');
    t.mock.timers.tick(1);
    await begin();
  };
  await harness.commands.get('goal').handler('Finish the complete approved objective', harness.ctx);
  return { harness, state, tool, report, begin, finish, next };
}

for (const version of Object.keys(GOAL_FIXTURES)) {
  describe(`Goal ${version}`, () => {
    it('REQ-AGENT-111 / REQ-OPS-020: prepares the exact release and repeats byte-identically', t => {
      const root = prepareGoal(t, version);
      const prepared = snapshot(root);
      assert.deepEqual(JSON.parse(prepared['package.json']).pi.extensions, ['./src/index.ts']);
      patchPiGoalDirectory(version, root);
      assert.deepEqual(snapshot(root), prepared);
    });

    for (const prepared of [false, true]) {
      const phase = prepared ? 'prepared' : 'pristine';
      for (const [path, drift, diagnostic] of [
        ['package.json', manifest => ({ ...manifest, name: 'unreviewed' }), /identity mismatch/],
        ['package.json', manifest => ({ ...manifest, version: '0.0.0' }), /!= expected/],
        ['package.json', manifest => ({ ...manifest, pi: { extensions: ['./unknown.ts'] } }), /unsupported Pi extension entrypoint/],
        ...['index', 'commands', 'goal', 'lifecycle', 'persistence', 'prompts', 'runtime', 'safety',
          'settings', 'tool-policy', 'tools', 'usage-limit-recovery', 'usage-reset',
          ...(version === LATEST ? ['wait-renderer'] : [])].map(name => [`src/${name}.ts`, null, /source digest changed/]),
      ]) {
        it(`rejects ${phase} ${path} drift (${diagnostic.source}) before any package write`, t => {
          const root = prepared ? prepareGoal(t, version) : unpackGoal(t, version);
          const pathOnDisk = join(root, path);
          const source = readFileSync(pathOnDisk, 'utf8');
          writeFileSync(pathOnDisk, drift ? JSON.stringify(drift(JSON.parse(source))) : `${source}\n// Unreviewed drift\n`);
          const before = snapshot(root);
          assert.throws(() => patchPiGoalDirectory(version, root), diagnostic);
          assert.deepEqual(snapshot(root), before);
        });
      }
    }

    it('REQ-AGENT-111/129/178: fifth paraphrased stalled automatic run blocks, cancels queued work and releases workflow', async t => {
      const s = await createStallScenario(t, version);
      await s.begin();
      await s.report('advanced');
      await s.finish('Prepared the objective fixture.');
      const paraphrases = ['Still awaiting upstream.', 'The external result has not arrived.',
        'No change at the service.', 'Waiting for the requested event.', 'The prerequisite remains unavailable.'];
      for (let index = 0; index < paraphrases.length; index++) {
        await s.next();
        // Several model/tool turns still make exactly one completed automatic run.
        await s.finish(paraphrases[index], 3);
        assert.equal(s.state().status, index === 4 ? 'blocked' : 'active');
        assert.equal(s.state().toolFreeRepeatCount, index + 1, 'upstream public progress counter projects verified stalled runs');
        // Duplicate delivery of the same completion boundary is not another run.
        await s.harness.dispatch('agent_end', { messages: [{ role: 'assistant',
          content: [{ type: 'text', text: paraphrases[index] }], stopReason: 'stop' }] });
        assert.equal(s.state().status, index === 4 ? 'blocked' : 'active');
      }
      const message = { role: 'assistant', content: [{ type: 'text', text: 'Late duplicate end' }], stopReason: 'stop' };
      await s.harness.dispatch('agent_end', { messages: [message] });
      t.mock.timers.tick(3_600_000);
      await s.harness.dispatch('agent_settled');
      assert.equal(s.harness.messages.length, 0, 'blocked Goal never queues another automatic prompt');
      assert.equal((await s.harness.dispatch('tool_call', { toolName: 'read', input: {} }))?.block, true);
      // Intentional shared workflow protocol: another workflow can acquire after
      // terminal Goal cleanup, not merely after a compensating resume/clear.
      const attempt = { session: s.harness.ctx.sessionManager, group: 'agent-workflow', busy: false };
      await s.harness.emit('workflow:mutex:v1', attempt);
      assert.equal(attempt.busy, false);
      await s.harness.commands.get('goal').handler('resume', s.harness.ctx);
      assert.equal(s.state().status, 'active', 'terminal transition released workflow ownership for explicit resume');
    });

    it('REQ-AGENT-111/129: polling, failed tools, extraction and arbitrary notifications cannot reset the stall streak', async t => {
      const s = await createStallScenario(t, version, { noProgressTurns: 999, minIntervalMs: 1 });
      await s.begin();
      await s.report('advanced');
      await s.finish();
      for (let index = 0; index < 5; index++) {
        await s.next();
        for (const [toolName, isError] of [['bash', false], ['read', true], ['memory_capture', false]]) {
          await s.harness.dispatch('tool_call', { toolName, input: { command: 'poll external status' } });
          await s.harness.dispatch('tool_execution_end', { toolName, isError,
            result: { content: [{ type: 'text', text: isError ? 'Request failed' : 'No new result' }] } });
        }
        await s.harness.dispatch('input', { source: 'extension', text: `Status notification ${index}` });
        await s.harness.dispatch('context', { messages: [] });
        await s.finish(`Rephrased pending external status ${index}`);
        assert.equal(s.state().status, index === 4 ? 'blocked' : 'active');
      }
    });

    it('REQ-AGENT-111/129: evidenced advanced reports reset stalls and permit productive execution beyond old automatic defaults', async t => {
      const s = await createStallScenario(t, version);
      await s.begin();
      await s.report('advanced');
      await s.finish();
      for (let index = 0; index < 32; index++) {
        await s.next();
        if (index % 4 === 3) {
          const result = await s.report('advanced', `Completed objective item ${index}; artifact ${index} verified against its requirement.`);
          assert.doesNotMatch(result.content[0].text, /rejected/i);
          assert.equal(s.state().toolFreeRepeatCount, 0, 'evidenced advancement resets the public stall projection');
        }
        await s.finish(`Objective item ${index}`);
        assert.equal(s.state().status, 'active');
      }
      for (let index = 0; index < 5; index++) {
        await s.next();
        await s.finish(`Subsequent stall ${index}`);
        assert.equal(s.state().status, index === 4 ? 'blocked' : 'active');
      }
    });

    for (const errorMessage of ['503 service unavailable', 'input exceeds the context window']) {
    it(`REQ-AGENT-111/129: automatic recovery is paced and each completed error run counts once (${errorMessage})`, async t => {
      const s = await createStallScenario(t, version);
      let aborted = false;
      s.harness.ctx.abort = () => { aborted = true; };
      await s.begin();
      await s.report('advanced');
      await s.finish();
      for (let count = 1; count <= 5; count++) {
        await s.next();
        await s.finish('Retryable provider failure', 1, errorMessage, false);
        assert.equal(s.state().toolFreeRepeatCount, count);
        assert.equal(s.state().status, count === 5 ? 'blocked' : 'active');
        if (count === 5) break;
        aborted = false;
        if (errorMessage.includes('context window')) {
          await s.harness.dispatch('session_before_compact', { willRetry: true });
        }
        await s.harness.dispatch('agent_start'); // Pi retries without before_agent_start.
        assert.equal(aborted, true, 'early Pi-owned automatic recovery is aborted before provider work');
        const report = await s.report('advanced');
        assert.match(report.content[0].text, /rejected/, 'deferred recovery does not own a Goal run');
        await s.harness.dispatch('agent_end', { messages: [{ role: 'assistant', stopReason: 'aborted' }] });
        await s.harness.dispatch('agent_end', { messages: [{ role: 'assistant', stopReason: 'error', errorMessage }] });
        await s.harness.dispatch('agent_settled');
        assert.equal(s.state().status, 'active');
        assert.equal(s.state().toolFreeRepeatCount, count, 'aborted recovery and duplicate end do not count again');
        assert.equal(s.harness.messages.length, 0);
      }
      t.mock.timers.tick(3_600_000);
      await s.harness.dispatch('agent_settled');
      assert.equal(s.harness.messages.length, 0, 'terminal blocking cancels recovery delivery');
    });
    }

    it('REQ-AGENT-130 AC2: full preparation respects a configured interval above five minutes and caps stalls at the deadline', async t => {
      const s = await createStallScenario(t, version, { minIntervalMs: 600_000 });
      await s.begin();
      await s.report('stalled', 'Required external artifact remains unavailable.');
      await s.finish();
      for (let count = 1; count <= 2; count++) {
        t.mock.timers.tick(599_999);
        assert.equal(s.harness.messages.length, 0, 'no delivery before the complete configured ten-minute interval');
        t.mock.timers.tick(1);
        await s.begin();
        await s.finish(`External artifact still unavailable at attempt ${count}.`);
        assert.equal(s.state().toolFreeRepeatCount, count);
        assert.equal(s.state().status, 'active');
      }
      t.mock.timers.tick(299_999);
      assert.equal(s.state().status, 'active');
      assert.equal(s.harness.messages.length, 0);
      t.mock.timers.tick(1);
      assert.equal(s.state().status, 'blocked', '25-minute deadline caps the next ten-minute interval');
      assert.equal(s.state().toolFreeRepeatCount, 2, 'deadline does not invent attempts');
      assert.match(JSON.stringify(s.harness.notifications), /deadline|25.minute/i);
      assert.equal(s.harness.messages.length, 0);
    });

    it('REQ-AGENT-111/129: backward wall-clock correction cannot shorten persisted automatic spacing', async t => {
      const s = await createStallScenario(t, version);
      await s.begin();
      await s.report('advanced');
      await s.finish();
      t.mock.timers.setTime(Date.now() - 120_000);
      t.mock.timers.tick(300_000);
      assert.equal(s.harness.messages.length, 0);
      t.mock.timers.tick(119_999);
      assert.equal(s.harness.messages.length, 0);
      t.mock.timers.tick(1);
      await s.begin();
      await s.finish();
      assert.equal(s.state().status, 'active');
    });

    it('REQ-AGENT-272 AC3: an in-flight automatic run is aborted at the stalled deadline without a lifecycle event', async t => {
      const s = await createStallScenario(t, version, { minIntervalMs: 1_440_000 });
      await s.begin();
      await s.report('stalled');
      await s.finish();
      const deadline = s.state().stalledSince + 1_500_000;
      t.mock.timers.tick(1_440_000);
      await s.begin();
      s.harness.ctx.isIdle = () => false;
      t.mock.timers.tick(59_999);
      assert.equal(s.state().status, 'active');
      assert.deepEqual(s.harness.aborts, []);
      t.mock.timers.tick(1);
      assert.equal(s.state().status, 'blocked');
      assert.deepEqual(s.harness.aborts, [deadline]);
      assert.equal(s.state().toolFreeRepeatCount, 0, 'an interrupted attempt did not complete');
      await s.finish();
      t.mock.timers.tick(1_500_000);
      assert.equal(s.harness.messages.length, 0);
      assert.deepEqual(s.harness.aborts, [deadline]);
    });

    it('REQ-AGENT-272 AC3: a backward clock correction rearms at the earlier stall deadline, not the next dispatch', async t => {
      const s = await createStallScenario(t, version, { minIntervalMs: 1_800_000 });
      await s.begin();
      await s.report('stalled');
      await s.finish();
      const started = Date.now();
      // Move wall time independently of the already-armed timeout budget.
      let wallTime = started + 1_380_000;
      t.mock.method(Date, 'now', () => wallTime);
      t.mock.timers.tick(1_500_000);
      assert.equal(s.state().status, 'active', 'the first wake precedes the absolute deadline');
      wallTime += 119_999;
      t.mock.timers.tick(119_999);
      assert.equal(s.state().status, 'active');
      wallTime++;
      t.mock.timers.tick(1);
      assert.equal(s.state().status, 'blocked');
      assert.equal(s.harness.messages.length, 0);
      assert.deepEqual(s.harness.aborts, []);
    });

    it('REQ-AGENT-272 AC3: a stall expires while an unrelated run is busy without aborting it', async t => {
      const s = await createStallScenario(t, version);
      await s.begin();
      await s.report('stalled');
      await s.finish();
      await s.harness.dispatch('before_agent_start', { messageType: 'custom' });
      await s.harness.dispatch('agent_start');
      s.harness.ctx.isIdle = () => false;
      t.mock.timers.tick(1_500_000);
      assert.equal(s.state().status, 'blocked');
      assert.equal(s.harness.messages.length, 0);
      const hook = await s.harness.dispatch('tool_call', { toolName: 'read', input: { path: 'unrelated.txt' } });
      assert.notEqual(hook?.block, true, 'unrelated work can continue after the Goal stops');
      assert.deepEqual(s.harness.aborts, []);
    });

    it('REQ-AGENT-272 AC3: evidenced advancement cancels an existing in-flight stall deadline', async t => {
      const s = await createStallScenario(t, version);
      await s.begin();
      await s.report('stalled');
      t.mock.timers.tick(1_499_999);
      await s.report('advanced');
      s.harness.ctx.isIdle = () => false;
      t.mock.timers.tick(1);
      assert.equal(s.state().status, 'active');
      assert.equal(s.state().stalledSince, undefined);
      assert.deepEqual(s.harness.aborts, []);
    });

    it('REQ-AGENT-236 AC3: late non-goal notification cannot defer the stalled deadline behind persisted spacing', async t => {
      const s = await createStallScenario(t, version);
      await s.begin();
      await s.report('stalled', 'External prerequisite remains pending.');
      await s.finish();
      for (let index = 0; index < 4; index++) {
        await s.next();
        await s.finish(`External prerequisite still pending, attempt ${index + 1}.`);
      }
      assert.equal(s.state().toolFreeRepeatCount, 4);
      t.mock.timers.tick(240_000);
      await s.harness.dispatch('input', { source: 'extension', text: 'Memory capture completed' });
      await s.begin('Memory capture completed');
      await s.finish('Memory capture notification acknowledged; external prerequisite unchanged.');
      assert.equal(s.state().status, 'active');
      assert.equal(s.state().toolFreeRepeatCount, 4, 'notification is not an automatic attempt');
      t.mock.timers.tick(60_000);
      assert.equal(s.state().status, 'blocked');
      assert.equal(s.state().toolFreeRepeatCount, 4, 'deadline does not fabricate a fifth attempt');
      assert.match(JSON.stringify(s.harness.notifications), /deadline|25.minute/i);
      assert.doesNotMatch(JSON.stringify(s.harness.notifications), /five stalled automatic|5 stalled automatic/i);
      assert.equal(s.harness.messages.length, 0);
      t.mock.timers.tick(3_600_000);
      await s.harness.dispatch('agent_settled');
      assert.equal(s.harness.messages.length, 0, 'no overdue catch-up prompt follows deadline blocking');
    });

    it('REQ-AGENT-111/129: manual stalled report starts a 25-minute deadline without inventing automatic attempts', async t => {
      const s = await createStallScenario(t, version);
      await s.begin();
      await s.report('stalled', 'External service returned pending; the required artifact is absent.');
      await s.finish();
      assert.equal(s.state().toolFreeRepeatCount, 0, 'manual stall starts a deadline, not an automatic-attempt count');
      // Suspension advances wall clock without fabricating timer callbacks/runs.
      t.mock.timers.setTime(Date.now() + 25 * 60_000);
      await s.harness.dispatch('agent_settled');
      assert.equal(s.state().status, 'blocked');
      assert.equal(s.harness.messages.length, 0, 'no overdue catch-up prompt is sent');
      await s.harness.commands.get('goal').handler('', s.harness.ctx);
      assert.match(JSON.stringify(s.harness.notifications), /deadline|25.minute/i);
      assert.doesNotMatch(JSON.stringify(s.harness.notifications), /five stalled automatic|5 stalled automatic/i);
    });

    it('REQ-AGENT-111/129: restart and compaction retain stalls, while explicit resume starts a fresh epoch', async t => {
      const s = await createStallScenario(t, version);
      await s.begin();
      await s.report('advanced');
      await s.finish();
      for (let index = 0; index < 3; index++) {
        await s.next();
        await s.finish(`Stall before restoration ${index}`);
      }
      assert.equal(s.state().toolFreeRepeatCount, 3);
      const stalledSince = s.state().stalledSince;
      await s.harness.dispatch('session_before_compact', {});
      await s.harness.dispatch('session_compact', {});
      assert.equal(s.state().toolFreeRepeatCount, 3);
      assert.equal(s.state().stalledSince, stalledSince);
      await s.harness.dispatch('session_shutdown');
      await s.harness.startSession();
      assert.equal(s.state().toolFreeRepeatCount, 3);
      assert.equal(s.state().stalledSince, stalledSince);
      // Normal restoration preserves the existing count. Compaction may rearm
      // delivery but cannot introduce an unpaced or extra automatic attempt.
      await s.harness.dispatch('agent_settled');
      for (let index = 0; index < 2; index++) {
        await s.next();
        await s.finish(`Stall after restoration ${index}`);
        assert.equal(s.state().status, index === 1 ? 'blocked' : 'active');
      }
      const stoppedId = s.state().id;
      await s.harness.commands.get('goal').handler('resume', s.harness.ctx);
      assert.notEqual(s.state().id, stoppedId);
      await s.begin();
      assert.equal(s.state().status, 'active', 'owned resume resets the old epoch before enforcing its limits');
      assert.equal(s.state().toolFreeRepeatCount, 0);
      assert.equal(s.state().stalledSince, undefined);
      const resumed = await s.report('stalled', 'Explicitly retrying the unresolved external prerequisite.');
      assert.doesNotMatch(resumed.content[0].text, /rejected/);
      await s.report('advanced', 'Completed the first resumed objective item and verified its artifact.');
      await s.finish();
      for (let index = 0; index < 5; index++) {
        await s.next();
        await s.finish(`Fresh retry ${index}`);
        assert.equal(s.state().status, index === 4 ? 'blocked' : 'active');
      }
    });

    for (const stoppedStatus of ['paused', 'blocked']) {
      it(`REQ-AGENT-236 AC4: ${stoppedStatus} resume clears expired history before pending delivery and lifecycle enforcement`, async t => {
        const s = await createStallScenario(t, version, { automaticTurns: 12 });
        await s.begin();
        await s.report('advanced');
        await s.finish();
        await s.next();
        await s.finish();
        if (stoppedStatus === 'paused') await s.harness.commands.get('goal').handler('pause', s.harness.ctx);
        t.mock.timers.setTime(Date.now() + 26 * 60_000);
        if (stoppedStatus === 'blocked') await s.harness.runContext();
        const stopped = structuredClone(s.state());
        assert.equal(stopped.status, stoppedStatus);
        assert.equal(stopped.stalledRuns, 1);
        let releaseDelivery;
        const delivery = s.harness.api.sendUserMessage;
        s.harness.api.sendUserMessage = async (content, options) => {
          await new Promise(resolve => { releaseDelivery = resolve; });
          await delivery(content, options);
        };
        const resuming = s.harness.commands.get('goal').handler('resume', s.harness.ctx);
        try {
          assert.equal(s.state().status, 'active');
          assert.notEqual(s.state().id, stopped.id);
          assert.equal(s.state().stalledSince, undefined, 'expired deadline is gone before prompt delivery');
          assert.equal(s.state().stalledRuns, undefined);
          assert.equal(s.state().nextAutomaticAt, undefined);
          assert.equal(s.state().toolFreeRepeatCount, 0);
          assert.equal(s.state().automaticModelTurns, stopped.automaticModelTurns, 'finite epoch stays deferred');
          assert.equal(s.state().safetyResetPending, true);
          for (const field of ['text', 'tokensUsed', 'timeUsedSeconds', 'tokenBudget', 'iteration']) {
            assert.equal(s.state()[field], stopped[field], `${field} survives resume`);
          }
          await s.harness.dispatch('input', { text: 'Review the resumed objective', source: 'user' });
          await s.harness.runContext();
          t.mock.timers.tick(1);
          assert.equal(s.state().status, 'active', 'pre-prompt lifecycle and old timers cannot restore the expired deadline');
        } finally {
          releaseDelivery?.();
          await resuming;
        }
        await s.begin();
        assert.equal(s.state().automaticModelTurns, 0, 'owned prompt commits the deferred finite epoch');
        await s.report('stalled', 'Fresh retry still awaits the external prerequisite.');
        const freshSince = s.state().stalledSince;
        assert.ok(freshSince > stopped.stalledSince);
        await s.finish();
        t.mock.timers.setTime(freshSince + 25 * 60_000 - 1);
        await s.harness.runContext();
        assert.equal(s.state().status, 'active');
        t.mock.timers.setTime(freshSince + 25 * 60_000);
        await s.harness.runContext();
        assert.equal(s.state().status, 'blocked', 'a genuine fresh 25-minute stall still blocks');
        assert.equal(s.state().toolFreeRepeatCount, 0);
        assert.equal(s.harness.messages.length, 0);
      });
    }

    it('REQ-AGENT-236 AC4: prompt-suppressed control resume clears the expired deadline before any new owned prompt', async t => {
      const s = await createStallScenario(t, version);
      await s.begin();
      await s.report('stalled', 'External prerequisite is not ready.');
      await s.finish();
      let response;
      await s.harness.emit(CONTROL_CHANNEL, { action: 'pause', goalId: s.state().id, respond: value => { response = value; } });
      assert.equal(response.ok, true);
      const stopped = structuredClone(s.state());
      t.mock.timers.setTime(Date.now() + 26 * 60_000);
      await s.harness.emit(CONTROL_CHANNEL, { action: 'resume', goalId: stopped.id, respond: value => { response = value; } });
      assert.equal(response.ok, true);
      assert.notEqual(response.goalId, stopped.id);
      assert.equal(s.state().stalledSince, undefined);
      assert.equal(s.state().stalledRuns, undefined);
      assert.equal(s.state().nextAutomaticAt, undefined);
      assert.equal(s.state().toolFreeRepeatCount, 0);
      assert.equal(s.harness.messages.length, 0, 'control resume does not send its own prompt');
      await s.harness.dispatch('input', { text: 'Continue after review', source: 'user' });
      await s.harness.runContext();
      t.mock.timers.tick(1);
      assert.equal(s.state().status, 'active');
      await s.harness.dispatch('session_shutdown');
      await s.harness.startSession();
      await s.harness.runContext();
      assert.equal(s.state().status, 'active', 'restoring a resumed goal cannot resurrect the expired history');
      assert.equal(s.state().stalledSince, undefined);
    });

    for (const stoppedStatus of ['paused', 'blocked']) {
      it(`REQ-AGENT-236 AC4: failed ${stoppedStatus} resume restores original history and remains stopped after reload`, async t => {
        const s = await createStallScenario(t, version);
        await s.begin();
        await s.finish();
        if (stoppedStatus === 'paused') await s.harness.commands.get('goal').handler('pause', s.harness.ctx);
        t.mock.timers.setTime(Date.now() + 26 * 60_000);
        if (stoppedStatus === 'blocked') await s.harness.runContext();
        const stopped = structuredClone(s.state());
        s.harness.api.sendUserMessage = async () => { throw new Error('resume delivery unavailable'); };
        await s.harness.commands.get('goal').handler('resume', s.harness.ctx);
        assert.deepEqual(s.state(), stopped, 'failed delivery restores the stopped instance without mutating its stall history');
        await s.harness.dispatch('session_shutdown');
        await s.harness.startSession();
        await s.harness.runContext();
        assert.equal(s.state().status, stoppedStatus);
        assert.equal(s.state().id, stopped.id);
        assert.equal(s.state().stalledSince, stopped.stalledSince);
        assert.equal(s.state().toolFreeRepeatCount, stopped.toolFreeRepeatCount);
        assert.equal(s.harness.messages.length, 0);
        assert.ok(s.harness.notifications.some(({ message }) => message.includes('resume delivery unavailable')));
      });
    }

    it('REQ-AGENT-236 AC4: waking an active waiting goal keeps its genuine stalled deadline', async t => {
      const s = await createStallScenario(t, version);
      await s.begin();
      await s.report('stalled', 'External prerequisite is not ready.');
      await s.tool('goal_wait').execute('wait', { goal_id: s.state().id, reason: 'External event is arranged.' },
        undefined, undefined, s.harness.ctx);
      await s.finish();
      const waiting = structuredClone(s.state());
      t.mock.timers.tick(60_000);
      await s.harness.commands.get('goal').handler('resume', s.harness.ctx);
      await s.begin();
      assert.equal(s.state().id, waiting.id);
      assert.equal(s.state().waiting, undefined);
      assert.equal(s.state().stalledSince, waiting.stalledSince);
      t.mock.timers.setTime(waiting.stalledSince + 25 * 60_000);
      await s.harness.runContext();
      assert.equal(s.state().status, 'blocked');
    });

    it('REQ-AGENT-111/129: legacy output-repeat counters are not fabricated stalled-attempt history', async t => {
      const s = await createStallScenario(t, version);
      await s.begin();
      await s.report('advanced');
      await s.finish();
      await s.harness.dispatch('session_shutdown');
      // Intentional persisted-state migration contract: old fingerprint counters
      // are not evidence that any goal_progress automatic attempt was completed.
      const legacy = { ...s.state(), toolFreeRepeatCount: 999,
        lastToolFreeOutputFingerprint: 'a'.repeat(64) };
      s.harness.entries.push({ type: 'custom', customType: 'goal-state', data: { goal: legacy } });
      await s.harness.startSession();
      assert.equal(s.state().status, 'active');
      assert.equal(s.state().toolFreeRepeatCount, 0, 'old repeat history is not displayed as verified stalled attempts');
      await s.harness.dispatch('agent_settled');
      for (let index = 0; index < 5; index++) {
        await s.next();
        await s.finish(`Actual observed stall ${index}`);
        assert.equal(s.state().status, index === 4 ? 'blocked' : 'active');
      }
    });

    it('REQ-AGENT-111/129: explicit automatic-work preference and manual pause still stop productive dispatch', async t => {
      const s = await createStallScenario(t, version, { automaticTurns: 2 });
      await s.begin();
      await s.report('advanced');
      await s.finish();
      for (let index = 0; index < 2; index++) {
        await s.next();
        await s.report('advanced', `Completed verified objective item ${index}.`);
        await s.finish('Productive objective work.');
      }
      assert.equal(s.state().status, 'paused', 'valid explicit automatic limit remains enforced');
      t.mock.timers.tick(300_000);
      assert.equal(s.harness.messages.length, 0);
      await s.harness.commands.get('goal').handler('resume', s.harness.ctx);
      await s.begin();
      await s.report('advanced');
      await s.finish();
      await s.harness.commands.get('goal').handler('pause', s.harness.ctx);
      t.mock.timers.tick(300_000);
      await s.harness.dispatch('agent_settled');
      assert.equal(s.state().status, 'paused');
      assert.equal(s.harness.messages.length, 0);
    });

    it('REQ-AGENT-111/129: persisted deadline survives shutdown and blocks immediately after a wall-clock gap', async t => {
      const s = await createStallScenario(t, version);
      await s.begin();
      await s.report('stalled', 'Service response confirms a pending external prerequisite.');
      await s.finish();
      await s.harness.dispatch('session_shutdown');
      t.mock.timers.setTime(Date.now() + 26 * 60_000);
      await s.harness.startSession();
      assert.equal(s.state().status, 'blocked');
      await s.harness.dispatch('agent_settled');
      t.mock.timers.tick(300_000);
      assert.equal(s.harness.messages.length, 0);
    });

    for (const resumeAfter of [undefined, 3_600_000]) {
      it(`REQ-AGENT-111/129: external quiet wait (${resumeAfter ?? 'no safety wake'}) cannot bypass stall deadline`, async t => {
        const s = await createStallScenario(t, version);
        await s.begin();
        await s.report('stalled', 'Arranged external completion event; no artifact is available.');
        const result = await s.tool('goal_wait').execute('wait', { goal_id: s.state().id,
          reason: 'External completion event is arranged.', ...(resumeAfter === undefined ? {} : { resume_after_ms: resumeAfter }) },
        undefined, undefined, s.harness.ctx);
        assert.equal(result.terminate, true);
        await s.finish();
        t.mock.timers.tick(25 * 60_000 - 1);
        assert.equal(s.state().status, 'active');
        assert.equal(s.harness.messages.length, 0);
        t.mock.timers.tick(1);
        assert.equal(s.state().status, 'blocked');
        assert.equal(s.harness.messages.length, 0);
      });
    }

    it('REQ-AGENT-111/129: terminal blocker tool rejects retired and unearned attempt counts', async t => {
      const s = await createStallScenario(t, version);
      await s.begin();
      const blocked = s.tool('goal_blocked');
      // Intentional public tool protocol: five is the minimum documented claim.
      assert.equal(blocked.parameters.properties.repeated_turns.minimum, 5);
      assert.doesNotMatch(blocked.description, /three consecutive/i);
      for (const repeated_turns of [3, 4, 5, 50]) {
        const before = structuredClone(s.state());
        const result = await blocked.execute('blocked', { goal_id: before.id, repeated_turns,
          reason: 'External prerequisite must be completed.', evidence: 'Service still reports pending.' },
        undefined, undefined, s.harness.ctx);
        assert.match(result.content[0].text, /rejected/i);
        assert.notEqual(result.terminate, true);
        assert.deepEqual(s.state(), before);
      }
    });

    for (const origin of ['manual', 'automatic']) {
      it(`REQ-AGENT-272 AC3/AC4: blocker requires four completed stalls and an evidenced automatic fifth (${origin})`, async t => {
        const s = await createStallScenario(t, version);
        const block = repeated_turns => s.tool('goal_blocked').execute('blocked', { goal_id: s.state().id, repeated_turns,
          reason: 'External prerequisite must be completed.', evidence: 'Service still reports pending.' },
        undefined, undefined, s.harness.ctx);
        const rejected = async (count = 5) => {
          const before = structuredClone(s.state());
          const result = await block(count);
          assert.match(result.content[0].text, /rejected/i);
          assert.notEqual(result.terminate, true);
          assert.deepEqual(s.state(), before);
        };
        await s.begin();
        await s.report('advanced');
        await s.finish();
        for (let index = 0; index < 4; index++) {
          await s.next();
          await s.finish();
        }
        assert.equal(s.state().stalledRuns, 4);
        if (origin === 'automatic') await s.next();
        else await s.begin('Manually check objective');
        await rejected();
        await s.report('stalled');
        if (origin === 'manual') {
          await rejected();
        } else {
          await rejected(50);
          const result = await block(5);
          assert.equal(result.terminate, true);
          assert.equal(result.details.repeated_turns, 5);
          assert.equal(s.state().status, 'blocked');
        }
      });
    }

    it('REQ-AGENT-111/178: progress rejects an owned run whose workflow session has been replaced', async t => {
      const root = prepareGoal(t, version);
      const { GoalRuntime } = await loadFixture(t, root, './src/runtime.ts');
      const { registerGoalTools } = await loadFixture(t, root, './src/tools.ts');
      const harness = createExtensionHarness();
      const runtime = new GoalRuntime(harness.api);
      runtime.bindWorkflowSession(harness.ctx.sessionManager);
      runtime.acquireWorkflow();
      runtime.activeGoal = { id: 'owner-goal', text: 'Complete approved objective', status: 'active',
        iteration: 0, tokensUsed: 0, startedAt: Date.now(), updatedAt: Date.now(),
        timeUsedSeconds: 0, baselineTokens: 0, automaticModelTurns: 0, toolFreeRepeatCount: 0 };
      runtime.beginAgentRun(runtime.activeGoal.id, 'manual');
      registerGoalTools(harness.api, runtime);
      runtime.bindWorkflowSession({});
      const before = structuredClone(runtime.activeGoal);
      const progress = harness.tools.find(tool => tool.name === 'goal_progress');
      assert.ok(progress);
      const result = await progress.execute('wrong-workflow', { goal_id: before.id, state: 'advanced',
        evidence: 'Completed verified objective artifact.' }, undefined, undefined, harness.ctx);
      assert.match(result.content[0].text, /rejected/i);
      assert.deepEqual(runtime.activeGoal, before);
      assert.equal(harness.entries.length, 0, 'rejection publishes no changed Goal state');
    });

    it('REQ-AGENT-111/178: progress rejects empty, oversized, invalid, stale, inactive and non-owned reports without mutation', async t => {
      const s = await createStallScenario(t, version);
      assert.ok(s.harness.activeTools().includes('goal_progress'));
      const beforeRun = structuredClone(s.state());
      const unowned = await s.report('advanced');
      assert.match(unowned.content[0].text, /rejected/i);
      assert.deepEqual(s.state(), beforeRun);
      await s.begin();
      for (const [stateValue, evidence, id] of [['advanced', ' ', s.state().id],
        ['advanced', 'x'.repeat(4001), s.state().id], ['unknown', 'Result verified', s.state().id],
        ['advanced', 'Result verified', 'stale-id']]) {
        const before = structuredClone(s.state());
        const result = await s.report(stateValue, evidence, id);
        assert.match(result.content[0].text, /rejected/i);
        assert.deepEqual(s.state(), before);
      }
      const accepted = await s.report('advanced');
      assert.doesNotMatch(accepted.content[0].text, /rejected/i);
      assert.notEqual(accepted.terminate, true, 'progress reports do not terminate productive work');
      await s.harness.commands.get('goal').handler('pause', s.harness.ctx);
      const paused = structuredClone(s.state());
      assert.match((await s.report('advanced')).content[0].text, /rejected/i);
      assert.deepEqual(s.state(), paused);
      await s.harness.dispatch('session_shutdown');
      const afterShutdown = structuredClone(s.state());
      assert.match((await s.report('advanced')).content[0].text, /rejected/i);
      assert.deepEqual(s.state(), afterShutdown);
    });

    for (const errorMessage of ['503 service unavailable', 'usage limit exceeded', 'input exceeds the context window']) {
      it(`Goal retains settled recovery classification (${errorMessage})`, async t => {
        const s = await createStallScenario(t, version);
        await s.begin();
        await s.report('advanced');
        await s.finish('Provider failed', 1, errorMessage);
        const expected = errorMessage.includes('usage limit') ? 'usage_limited'
          : errorMessage.includes('context window') ? 'blocked' : 'active';
        assert.equal(s.state().status, expected);
        if (expected === 'active') assert.ok(s.state().waiting, 'settled provider error waits for external input');
        assert.equal(s.harness.messages.length, 0, 'settlement does not invent a native retry');
      });
    }

    it('Goal retains confirmed length recovery across progress publication', async t => {
      const s = await createStallScenario(t, version);
      await s.begin();
      await s.report('advanced');
      const message = { role: 'assistant', content: [{ type: 'text', text: 'Partial output' }], stopReason: 'length' };
      await s.harness.dispatch('turn_end', { message });
      await s.harness.dispatch('agent_end', { messages: [message] });
      await s.harness.dispatch('session_before_compact', { willRetry: true });
      await s.harness.dispatch('agent_settled');
      assert.equal(s.state().status, 'blocked', 'confirmed but exhausted compaction recovery remains terminal');
      assert.equal(s.harness.messages.length, 0);
    });

    it('Goal preserves opt-in usage-limit retry scope and cancels queued work on model change', async t => {
      const s = await createStallScenario(t, version, {}, { retryUsageLimits: true });
      s.harness.ctx.model = { provider: 'fixture', id: 'original', api: 'fixture-api' };
      await s.begin();
      await s.report('advanced');
      await s.finish('', 1, 'usage limit exceeded');
      assert.equal(s.state().status, 'active');
      assert.deepEqual(s.state().waiting.usageLimit, { provider: 'fixture', model: 'original', api: 'fixture-api' });
      t.mock.timers.tick(15 * 60_000 - 1);
      assert.equal(s.harness.messages.length, 0);
      t.mock.timers.tick(1);
      // The five-minute Goal pacing gate still applies after the upstream wait.
      t.mock.timers.tick(5 * 60_000);
      assert.equal(s.harness.messages.length, 1);
      s.harness.ctx.model = { provider: 'fixture', id: 'replacement', api: 'fixture-api' };
      await s.harness.dispatch('model_select');
      assert.equal(s.state().status, 'usage_limited');
      const prompt = s.harness.messages.shift().content;
      const consumed = await s.harness.dispatch('input', { source: 'extension', text: prompt });
      assert.equal(consumed?.action, 'handled', 'queued retry is cancelled rather than transferred to another model');
      t.mock.timers.tick(60 * 60_000);
      assert.equal(s.harness.messages.length, 0);
    });

    it('REQ-AGENT-111 AC7: publishes concise Goal status without changing accounting or continuation details', async (t) => {
      const root = prepareGoal(t, version);
      const { GoalRuntime, goalSummary } = await loadFixture(t, root, './src/runtime.ts');
      const { formatDuration } = await loadFixture(t, root, './src/accounting.ts');
      const harness = createExtensionHarness();
      const runtime = new GoalRuntime(harness.api);
      const goal = { id: 'goal-status', text: 'status presentation', status: 'active', iteration: 4,
        tokensUsed: 250, startedAt: 0, updatedAt: 0, timeUsedSeconds: 63180, baselineTokens: 0, automaticModelTurns: 10 };
      for (const automaticTurns of [null, 10, 25]) {
        runtime.settings = { ...runtime.settings, continuationLimits: { ...runtime.settings.continuationLimits, automaticTurns } };
        for (const tokenBudget of [undefined, 1000]) {
          runtime.updateStatus(harness.ctx, { ...goal, tokenBudget });
          assert.equal(harness.statuses.get('goal'), 'goal - active 17h 33m');
        }
        for (const [status, expected] of [['blocked', 'blocked'], ['paused', 'paused'], ['usage_limited', 'usage limited'],
          ['budget_limited', 'budget limited'], ['complete', 'complete']]) {
          runtime.updateStatus(harness.ctx, { ...goal, status, tokenBudget: 1000 });
          assert.equal(harness.statuses.get('goal'), `goal - ${expected}`);
        }
        for (const safetyPauseCause of ['continuation_limit', 'no_progress']) {
          runtime.updateStatus(harness.ctx, { ...goal, status: 'paused', safetyPauseCause });
          assert.equal(harness.statuses.get('goal'), 'goal - paused');
        }
        runtime.updateStatus(harness.ctx, { ...goal, waiting: { reason: 'external event', resumeAt: 1000 } });
        assert.equal(harness.statuses.get('goal'), 'goal - waiting');
        const summary = goalSummary({ ...goal, tokenBudget: 1000 }, automaticTurns);
        assert.match(summary, /automatic/i);
        assert.match(summary, /250/);
        assert.match(summary, /1k|1,000|1000/i);
      }
      runtime.updateStatus(harness.ctx, { ...goal, timeUsedSeconds: 59 });
      assert.equal(harness.statuses.get('goal'), 'goal - active 59s');
      assert.equal(formatDuration(63180), '17h33m');
    });

  });
}

it('REQ-AGENT-236 AC4: the last release upgrades exact previous prepared safety', t => {
  const root = prepareGoal(t, '0.55.1');
  const current = snapshot(root);
  const previous = readFileSync(new URL('../__fixtures__/pi-goal-progress-safety.ts', import.meta.url));
  assert.equal(createHash('sha256').update(previous).digest('hex'),
    'd08d3a99ac0b4e4e0c87c5c81eb30ea5df832632078a6ab6283aeb01a3a6ff5d');
  writeFileSync(join(root, 'src/safety.ts'), previous);
  patchPiGoalDirectory('0.55.1', root);
  assert.deepEqual(snapshot(root), current);
});

it('REQ-AGENT-111: emits compact Goal prompts without blocked or wait tool coaching', async (t) => {
  const root = prepareGoal(t, LATEST);
  const prompts = await loadFixture(t, root, './src/prompts.ts');
  const goal = {
    id: 'goal-id',
    text: 'complete every open task',
    status: 'active',
    iteration: 4,
    tokensUsed: 0,
    startedAt: 0,
    updatedAt: 0,
    timeUsedSeconds: 0,
    baselineTokens: 0,
  };

  const continuation = prompts.buildContinuePrompt(goal, 'marker');
  assert.ok(continuation.length < 1_600, `continuation prompt grew to ${continuation.length} characters`);
  assert.match(continuation, /complete every open task/);
  assert.match(continuation, /goal_complete/);
  assert.doesNotMatch(continuation, /goal_blocked|goal_wait/);
  const waitingResume = prompts.buildWaitingResumePrompt(goal, 'waiting for user confirmation');
  assert.ok(waitingResume.length < 1_600, `waiting prompt grew to ${waitingResume.length} characters`);
  assert.doesNotMatch(waitingResume, /goal_blocked|goal_wait/);
  assert.match(waitingResume, /external_wait_reason/);

  // Goal prompt copy contract: every entry/resume/system/continuation output
  // carries the authoritative objective and exact completion stale-turn guard.
  for (const prompt of [prompts.buildGoalPrompt(goal), prompts.buildResumePrompt(goal, 'paused'),
    prompts.buildGoalSystemPrompt(goal), continuation, waitingResume]) {
    assert.match(prompt, /complete every open task/);
    assert.match(prompt, /<goal_id>\n?goal-id\n?<\/goal_id>/);
    assert.match(prompt, /goal_complete/);
    // Model-facing progress protocol: attempts/polling are not proof of work.
    assert.match(prompt, /goal_progress/);
    assert.match(prompt, /concrete evidence/i);
    assert.match(prompt, /five|fifth|5/i);
    assert.match(prompt, /blocked/i);
    assert.doesNotMatch(prompt, /goal_blocked|goal_wait/);
    assert.ok(prompt.length < 1_600);
  }
});

it('REQ-AGENT-129 AC5: rejects invalid minIntervalMs values', async (t) => {
  const root = prepareGoal(t, LATEST);
  const { normalizeGoalSettings, saveGoalSettings } = await loadFixture(t, root, './src/settings.ts');
  const path = join(root, 'settings.json');
  writeFileSync(path, '{}');
  for (const minIntervalMs of [null, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(
      normalizeGoalSettings({ continuationLimits: { minIntervalMs } }),
      undefined,
      `expected ${String(minIntervalMs)} to be rejected`,
    );
    assert.throws(() => saveGoalSettings({ continuationLimits: { minIntervalMs } }, path), /invalid/);
    assert.equal(readFileSync(path, 'utf8'), '{}', 'invalid settings must not replace saved settings');
  }
});

it('REQ-AGENT-129 AC6: defaults missing limits to bounded stalls and five-minute spacing', async (t) => {
  const root = prepareGoal(t, LATEST);
  const { normalizeGoalSettings } = await loadFixture(t, root, './src/settings.ts');
  const normalized = normalizeGoalSettings({ continuationLimits: {} });
  assert.deepEqual(normalized, {
    retryUsageLimits: false,
    rpc: { enabled: false },
    continuationLimits: { automaticTurns: null, noProgressTurns: 5, minIntervalMs: 300_000 },
  });
});

it('REQ-AGENT-129 AC7: saves the delay without dropping unknown fields', async (t) => {
  const root = prepareGoal(t, LATEST);
  const { normalizeGoalSettings, saveGoalSettings, readGoalSettings } = await loadFixture(t, root, './src/settings.ts');
  const path = join(root, 'settings.json');
  writeFileSync(path, JSON.stringify({ unknownRoot: 'keep', rpc: { unknownRpc: 'keep' }, continuationLimits: { unknownLimit: 'keep' } }));
  saveGoalSettings({ continuationLimits: { automaticTurns: 10, noProgressTurns: null, minIntervalMs: 60_000 } }, path);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
    unknownRoot: 'keep',
    retryUsageLimits: false,
    rpc: { enabled: false, unknownRpc: 'keep' },
    continuationLimits: {
      unknownLimit: 'keep',
      automaticTurns: 10,
      noProgressTurns: 5,
      minIntervalMs: 300_000,
    },
  });
  assert.equal(readGoalSettings(path).settings.continuationLimits.minIntervalMs, 300_000);
  assert.equal(
    normalizeGoalSettings({ continuationLimits: { minIntervalMs: Number.MAX_SAFE_INTEGER } })
      .continuationLimits.minIntervalMs,
    Number.MAX_SAFE_INTEGER,
  );
});

it('Goal review pause never aborts the caller and settings rollback does not publish or abort a blocked goal', async t => {
  const root = prepareGoal(t, LATEST);
  const { GoalRuntime } = await loadFixture(t, root, './src/runtime.ts');
  const { applyGoalSettings } = await loadFixture(t, root, './src/settings-ui.ts');
  const { default: extension } = await loadFixture(t, root, './src/index.ts');
  const harness = createExtensionHarness();
  extension(harness.api, { settingsPath: join(root, 'settings.json') });
  await harness.startSession();
  t.after(() => harness.dispatch('session_shutdown'));
  await harness.commands.get('goal').handler('Preserve review authority', harness.ctx);
  const state = () => harness.entries.filter(entry => entry.customType === 'goal-state').at(-1).data.goal;
  let aborted = false;
  harness.ctx.abort = () => { aborted = true; };
  let response;
  await harness.emit(CONTROL_CHANNEL, { action: 'pause', goalId: state().id, respond: value => { response = value; } });
  assert.equal(response.ok, true);
  assert.equal(state().status, 'paused');
  assert.equal(aborted, false, 'review control preserves its caller turn');
  await harness.commands.get('goal').handler('clear', harness.ctx);

  const runtime = new GoalRuntime(harness.api);
  runtime.bindWorkflowSession(harness.ctx.sessionManager);
  assert.equal(runtime.acquireWorkflow(), true);
  const active = { id: 'settings-goal', text: 'Preserve transactional settings', status: 'active', iteration: 0,
    tokensUsed: 0, startedAt: Date.now(), updatedAt: Date.now(), timeUsedSeconds: 0, baselineTokens: 0,
    automaticModelTurns: 0, stalledRuns: 5, stalledSince: Date.now() };
  runtime.activeGoal = structuredClone(active);
  runtime.beginAgentRun(active.id, 'automatic');
  const publications = [];
  runtime.setGoalStateSink(snapshot => publications.push(snapshot));
  const previousSettings = structuredClone(runtime.settings);
  const previousMessages = structuredClone(harness.messages);
  let stored = previousSettings;
  const save = settings => { stored = structuredClone(settings); };
  let failStatus = true;
  const originalStatus = harness.ctx.ui.setStatus;
  harness.ctx.ui.setStatus = (...args) => {
    if (failStatus) { failStatus = false; throw new Error('status unavailable'); }
    originalStatus(...args);
  };
  assert.throws(() => applyGoalSettings(runtime, { ...previousSettings, retryUsageLimits: true }, harness.ctx, { save }), /status unavailable/);
  assert.deepEqual(runtime.activeGoal, active);
  assert.deepEqual(stored, previousSettings);
  assert.equal(aborted, false, 'failed settings must discard deferred abort');
  assert.deepEqual(publications, [], 'failed settings must discard terminal publication');
  assert.equal(runtime.ownsWorkflow(), true, 'rollback retains workflow authority');
  assert.deepEqual(harness.messages, previousMessages, 'failed settings send no additional Goal prompt');
  applyGoalSettings(runtime, { ...previousSettings, retryUsageLimits: true }, harness.ctx, { save });
  assert.equal(runtime.activeGoal.status, 'blocked');
  assert.equal(aborted, true);
  assert.equal(stored.retryUsageLimits, true);
  assert.equal(publications.at(-1).status, 'blocked');
  assert.equal(runtime.acquireWorkflow(), true, 'committed terminal transition releases authority');
  runtime.releaseWorkflow();
});

it('REQ-AGENT-272: the prepared entrypoint lazily exposes Goal tools and shares session ownership with Plan', async t => {
  const goalRoot = prepareGoal(t, LATEST);
  const planRoot = unpack(t, 'narumitw-pi-plan-mode-0.60.1.tgz',
    'sha512-TRG8ncSkkS9qgDSxIgRr5S5hohvB9pC/GaNb1OrIDnkXTDVL9SlU27B45MoZILQdTLzo8qklaniyhBx+7xZ4RA==');
  patchPiPlanModeDirectory('0.60.1', planRoot);
  const { default: goalExtension } = await loadFixture(t, goalRoot,
    JSON.parse(readFileSync(join(goalRoot, 'package.json'), 'utf8')).pi.extensions[0]);
  const { default: planExtension } = await loadFixture(t, planRoot, './dist/index.ts');
  const harness = createExtensionHarness();
  const state = () => harness.entries.filter(entry => entry.customType === 'goal-state').at(-1)?.data.goal;
  const planState = () => harness.entries.filter(entry => entry.customType === 'plan-mode-state').at(-1)?.data;
  const goalSettings = join(goalRoot, 'settings.json');
  writeFileSync(goalSettings, JSON.stringify({ toolVisibility: 'after-first-goal' }));
  goalExtension(harness.api, { settingsPath: goalSettings });
  planExtension(harness.api, { settingsPath: join(planRoot, 'settings.json') });
  t.after(() => harness.dispatch('session_shutdown'));
  await harness.startSession();
  harness.api.setActiveTools(['read']);
  assert.ok(!harness.activeTools().includes('goal_complete'));

  const goal = args => harness.commands.get('goal').handler(args, harness.ctx);
  const plan = args => harness.commands.get('plan').handler(args, harness.ctx);
  await goal('First integration objective');
  assert.equal(state().status, 'active');
  for (const name of ['goal_complete', 'goal_blocked', 'goal_progress']) assert.ok(harness.activeTools().includes(name));
  await plan('start');
  assert.ok(!planState()?.enabled);
  assert.match(harness.notifications.at(-1).message, /Another workflow is active/);

  await goal('clear');
  assert.equal(harness.statuses.has('goal'), false);
  harness.api.setActiveTools(['read']);
  await plan('start');
  await harness.runContext();
  assert.equal(planState()?.enabled, true);
  await goal('Must not replace active Plan');
  assert.match(harness.notifications.at(-1).message, /Another workflow is active/);
  assert.notEqual(state()?.status, 'active');
  assert.equal(planState()?.enabled, true);
  assert.ok(!harness.activeTools().includes('goal_complete'));

  await plan('exit');
  await goal('Second integration objective');
  assert.equal(state().status, 'active');
  const originalId = state().id;
  let response;
  const control = async (action, goalId) => {
    response = undefined;
    await harness.emit(CONTROL_CHANNEL, { action, goalId, respond: value => { response = value; } });
    return response;
  };
  assert.equal((await control('pause', originalId)).status, 'paused');
  assert.equal((await control('resume', state().id)).status, 'active');
  assert.notEqual(state().id, originalId);
  await harness.dispatch('before_agent_start', { prompt: 'Continue the resumed objective', systemPrompt: '' });
  await harness.dispatch('agent_start');
  const complete = harness.tools.find(tool => tool.name === 'goal_complete');
  const finish = goal_id => complete.execute('completion', { goal_id, summary: 'Verified all requirements' },
    undefined, undefined, harness.ctx);
  const rejected = await finish(originalId);
  assert.match(rejected.content[0].text, /goal_id does not match the active goal/);
  assert.notEqual(rejected.terminate, true);
  assert.equal(state().status, 'active');
  const accepted = await finish(state().id);
  assert.equal(accepted.terminate, true);
  assert.match(accepted.content[0].text, /Goal complete/);
  assert.equal(state(), null, 'successful completion clears the active Goal');
});

it('REQ-AGENT-272: review pause cancels timed work without aborting, and manual pause aborts', async t => {
  const s = await createStallScenario(t, LATEST);
  let aborts = 0;
  s.harness.ctx.abort = () => { aborts += 1; };
  await s.begin();
  await s.report('advanced');
  await s.finish();
  let response;
  const control = async (action, goalId) => {
    response = undefined;
    await s.harness.emit(CONTROL_CHANNEL, { action, goalId, respond: value => { response = value; } });
    return response;
  };
  assert.equal((await control('pause', 'stale-goal')).ok, false);
  assert.equal(s.state().status, 'active');
  assert.equal((await control('pause', s.state().id)).ok, true);
  assert.equal(s.state().status, 'paused');
  assert.equal(aborts, 0);
  t.mock.timers.tick(600_000);
  assert.equal(s.harness.messages.length, 0);
  assert.equal((await control('resume', s.state().id)).ok, true);
  assert.equal(s.harness.messages.length, 0);
  await s.harness.commands.get('goal').handler('pause', s.harness.ctx);
  assert.equal(s.state().status, 'paused');
  assert.equal(aborts, 1);
  await s.harness.dispatch('session_shutdown');
  assert.deepEqual(await control('resume', s.state().id), { ok: false, goalId: s.state().id, status: 'missing' });
  assert.equal(s.state().status, 'paused');
});

it('REQ-AGENT-272: a productive continuation waits beyond the Node timer maximum', async t => {
  const interval = 2_147_483_647 + 5_000;
  const s = await createStallScenario(t, LATEST, { minIntervalMs: interval });
  await s.begin();
  await s.report('advanced');
  await s.finish();
  t.mock.timers.tick(2_147_483_647);
  assert.equal(s.harness.messages.length, 0);
  t.mock.timers.tick(4_999);
  assert.equal(s.harness.messages.length, 0);
  t.mock.timers.tick(1);
  assert.equal(s.harness.messages.length, 1);
});
