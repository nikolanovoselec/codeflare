import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const extensions = fileURLToPath(new URL('../../preseed/agents/pi/extensions/', import.meta.url));
const bundleRoot = mkdtempSync(join(tmpdir(), 'pi-review-protocol-module-'));
let registerReviewEnforcement, readCompletion;
try {
  const output = join(bundleRoot, 'review.mjs');
  await build({
    stdin: { contents: 'export { registerReviewEnforcement } from "./review-enforcement.ts"; export { readCompletion } from "./review-completion-state.ts";', resolveDir: extensions },
    bundle: true, platform: 'node', format: 'esm', outfile: output, logLevel: 'silent',
  });
  ({ registerReviewEnforcement, readCompletion } = await import(pathToFileURL(output).href));
} finally {
  rmSync(bundleRoot, { recursive: true, force: true });
}

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'pi-review-protocol-'));
  const savedHome = process.env.HOME;
  const savedMode = process.env.SESSION_MODE;
  const savedRepo = globalThis[Symbol.for('codeflare.activeRepo')];
  process.env.HOME = home;
  delete process.env.SESSION_MODE;
  delete globalThis[Symbol.for('codeflare.activeRepo')];
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedMode === undefined) delete process.env.SESSION_MODE; else process.env.SESSION_MODE = savedMode;
    if (savedRepo === undefined) delete globalThis[Symbol.for('codeflare.activeRepo')]; else globalThis[Symbol.for('codeflare.activeRepo')] = savedRepo;
    rmSync(home, { recursive: true, force: true });
  });
  const repo = join(home, 'checkout');
  // Checkout discovery is filesystem-based. Live Git/GitHub identity reads are
  // external boundaries below; no Git mutation or reviewer is run by this suite.
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'sdd'));
  writeFileSync(join(repo, 'sdd/README.md'), '# SDD');
  const sessionFile = join(home, 'session.jsonl');
  writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3, id: 'root', cwd: repo }) + '\n');
  const entries = [];
  const identity = { gitHost: 'github.com', repository: 'owner/repo', pr: 42, branch: 'feature', base: 'main', head: 'a'.repeat(40) };
  const stateRoot = join(home, '.codeflare/review-state/v1');
  const f = { home, repo, sessionFile, entries, identity, stateRoot };
  f.application = (overrides = {}) => {
    const handlers = new Map();
    const messages = [];
    const prompts = [];
    let active = ['read', 'bash'];
    const pi = {
      on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
      events: { emit() {} },
      appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
      sendMessage: (message, options) => { messages.push({ ...message, options }); entries.push({ type: 'custom_message', ...message }); },
      getAllTools: () => ['read', 'bash', 'subagent'].map(name => ({ name, description: name })),
      getActiveTools: () => active,
      setActiveTools: names => { active = names; },
    };
    const ctx = {
      cwd: repo, hasUI: true,
      sessionManager: { getSessionFile: () => sessionFile, getHeader: () => ({}), getEntries: () => entries },
      ui: { select: async (title, options) => { prompts.push({ title, options }); return undefined; }, notify() {} },
    };
    registerReviewEnforcement(pi, {
      queryHead: async () => identity.head,
      queryBranch: async () => identity.branch,
      queryRepository: async () => ({ gitHost: identity.gitHost, repository: identity.repository }),
      queryPr: async () => ({ state: 'OPEN', baseRefName: identity.base, headRefOid: identity.head, headRefName: identity.branch, number: identity.pr }),
      headRetryDelaysMs: [0], ...overrides,
    });
    return { ctx, messages, prompts, emit: async (name, event = {}) => {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    } };
  };
  f.push = id => ({ toolName: 'bash', toolCallId: id, input: { command: 'git push origin feature' }, result: { isError: false } });
  f.terminal = (plan) => {
    // Public Pi transcript wire contract: launches, terminal task receipts and
    // canonical triage are supplied, never a fabricated completion projection.
    for (const lane of plan.details.requiredLanes) {
      const id = `${plan.details.boundaryToolUseId}-${lane}`;
      entries.push(
        { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id, name: 'subagent', arguments: {
          subagent_type: lane, run_in_background: true, inherit_context: false,
          prompt: `scope=diff\nreview_base=origin/main\noutput_file=/tmp/codeflare-pr-42-${plan.details.head.slice(0, 12)}-${lane}.md`,
        } }] } },
        { type: 'message', message: { role: 'toolResult', toolCallId: id, toolName: 'subagent', content: [{ type: 'text', text: 'accepted' }], isError: false } },
        { type: 'custom_message', customType: 'subagent-notification', content: `<task-notification><tool-use-id>${id}</tool-use-id><status>Done</status></task-notification>` },
      );
    }
    const ci = `${plan.details.boundaryToolUseId}-ci`;
    entries.push(
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: ci, name: 'subagent', arguments: {
        subagent_type: 'ci-monitor', run_in_background: true, inherit_context: false,
        prompt: JSON.stringify({ repo: identity.repository, pr: identity.pr, head: plan.details.head, cwd: repo }),
      } }] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: ci, toolName: 'subagent', content: [{ type: 'text', text: 'accepted' }], isError: false } },
      { type: 'custom_message', customType: 'subagent-notification', content: `<task-notification><tool-use-id>${ci}</tool-use-id><status>Done</status><result>CI_RESULT success\npr=42 head=${plan.details.head} repo=owner/repo</result></task-notification>` },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '| FINDING | VALIDITY | PROPOSED FIX | PROPORTIONALITY | MINIMAL DECISION |\n|---|---|---|---|---|' }] } },
    );
  };
  f.status = (id = identity) => readCompletion(id, { root: stateRoot }).status;
  return f;
}

test('REQ-AGENT-153: overlapping same-identity reconciliation exposes one exact-head launch plan', async t => {
  const f = fixture(t);
  let release, arrived;
  const gate = new Promise(resolve => { release = resolve; });
  const firstRefresh = new Promise(resolve => { arrived = resolve; });
  let hold = true;
  const app = f.application({ queryPr: async () => {
    const pr = { state: 'OPEN', baseRefName: 'main', headRefOid: f.identity.head, headRefName: 'feature', number: 42 };
    if (hold) { hold = false; arrived(); await gate; }
    return pr;
  } });
  const first = app.emit('tool_result', f.push('first'));
  await firstRefresh;
  await app.emit('tool_result', f.push('overlapping'));
  release();
  await first;
  assert.deepEqual(app.messages.map(message => ({ type: message.customType, head: message.details.head })),
    [{ type: 'pr-boundary-launch-plan', head: f.identity.head }]);
  assert.equal(f.status(), 'missing');
});

test('REQ-AGENT-153: delayed old identity cannot replace the overlapping current-head plan', async t => {
  const f = fixture(t);
  let release, arrived;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = new Promise(resolve => { arrived = resolve; });
  let hold = true;
  const app = f.application({ queryPr: async () => {
    const pr = { state: 'OPEN', baseRefName: 'main', headRefOid: f.identity.head, headRefName: 'feature', number: 42 };
    if (hold) { hold = false; arrived(); await gate; }
    return pr;
  } });
  const first = app.emit('tool_result', f.push('old'));
  await pending;
  f.identity.head = 'b'.repeat(40);
  await app.emit('tool_result', f.push('current'));
  release();
  await first;
  assert.deepEqual(app.messages.map(message => message.details.head), [f.identity.head]);
  assert.equal(f.status(), 'missing');
});

test('REQ-AGENT-153/171: overlapping terminal reconciliation emits one durable FIX follow-up', async t => {
  const f = fixture(t);
  let release, arrived;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = new Promise(resolve => { arrived = resolve; });
  let hold = false;
  const app = f.application({ queryPr: async () => {
    const pr = { state: 'OPEN', baseRefName: 'main', headRefOid: f.identity.head, headRefName: 'feature', number: 42 };
    if (hold) { hold = false; arrived(); await gate; }
    return pr;
  } });
  await app.emit('tool_result', f.push('round'));
  f.terminal(app.messages[0]);
  hold = true;
  const first = app.emit('agent_settled');
  await pending;
  await app.emit('agent_settled');
  release();
  await first;
  assert.equal(f.status(), 'complete');
  // Public protocol delivery contract: a completed round owns one FIX handoff.
  assert.deepEqual(app.messages.map(message => message.customType), ['pr-boundary-launch-plan', 'pr-boundary-fix-follow-up']);
});

test('REQ-AGENT-169: consent identity drift does not save either head or expose a launch', async t => {
  const f = fixture(t);
  const old = { ...f.identity };
  const app = f.application();
  app.ctx.ui.select = async () => { f.identity.head = 'b'.repeat(40); return 'Mark review complete'; };
  await app.emit('session_start');
  assert.equal(f.status(old), 'missing');
  assert.equal(f.status(), 'missing');
  assert.deepEqual(app.messages, []);
});

test('REQ-AGENT-171: terminal identity drift before marker write withholds FIX and completion', async t => {
  const f = fixture(t);
  const old = { ...f.identity };
  const app = f.application();
  await app.emit('tool_result', f.push('round'));
  f.terminal(app.messages[0]);
  f.identity.head = 'b'.repeat(40);
  await app.emit('agent_settled');
  assert.equal(f.status(old), 'missing');
  assert.equal(f.status(), 'missing');
  assert.deepEqual(app.messages.map(message => message.customType), ['pr-boundary-launch-plan']);
});

test('REQ-AGENT-171: marker-write failure withholds FIX; retry persists before FIX and reload suppresses exact exposure', async t => {
  const f = fixture(t);
  const app = f.application();
  await app.emit('tool_result', f.push('round'));
  f.terminal(app.messages[0]);
  mkdirSync(join(f.home, '.codeflare'));
  const blocker = join(f.home, '.codeflare/review-state');
  writeFileSync(blocker, 'not a directory');
  await app.emit('agent_settled');
  assert.equal(f.status(), 'missing');
  assert.deepEqual(app.messages.map(message => message.customType), ['pr-boundary-launch-plan']);
  rmSync(blocker);
  await app.emit('agent_settled');
  assert.equal(f.status(), 'complete');
  assert.equal(app.messages.at(-1).customType, 'pr-boundary-fix-follow-up');
  assert.equal(app.messages.at(-1).details.head, f.identity.head);
  const reloaded = f.application();
  await reloaded.emit('session_start');
  await reloaded.emit('tool_result', f.push('same-after-reload'));
  assert.deepEqual(reloaded.prompts, []);
  assert.deepEqual(reloaded.messages, []);
  f.identity.head = 'b'.repeat(40);
  await reloaded.emit('tool_result', f.push('new-after-reload'));
  assert.equal(reloaded.messages[0].customType, 'pr-boundary-launch-plan');
  assert.equal(reloaded.messages[0].details.head, f.identity.head);
  assert.notEqual(f.status(), 'complete');
});

test('REQ-AGENT-168/171: unfinished reload reoffers consent; default and child sessions remain suppressed', async t => {
  const f = fixture(t);
  const app = f.application();
  await app.emit('tool_result', f.push('unfinished'));
  const reloaded = f.application();
  await reloaded.emit('session_start');
  assert.deepEqual(reloaded.prompts[0].options, ['Mark review complete', 'Launch review']);
  assert.deepEqual(reloaded.messages, []);
  assert.equal(f.status(), 'missing');
  process.env.SESSION_MODE = 'default';
  await reloaded.emit('tool_result', f.push('default'));
  assert.deepEqual(reloaded.messages, []);
  delete process.env.SESSION_MODE;
  reloaded.ctx.sessionManager.getHeader = () => ({ parentSession: '/parent.jsonl' });
  await reloaded.emit('tool_result', f.push('child'));
  assert.deepEqual(reloaded.messages, []);
  assert.equal(f.status(), 'missing');
});
