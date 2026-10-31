import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import primaryIdentity from '../../image/chat/primary-identity.mjs';
import primaryConversations from '../../image/chat/primary-conversations.mjs';

// Proposed first-party wire contract, not SDK transition tests. The command is
// intentionally distinct from /new (Dashboard intercepts that to spawn).
// Root must authorize/fence before transport, then match this outcome AND
// reconfirm the native identity/stock registration before rebinding the browser.
const command = 'codeflare-conversation';
const generation = 42;
const forbidden = () => { throw new Error('No abort, runtime creation, prompt delivery or waiting for idle is authorized'); };

function fixture(t, { owner = true, mode = 'tui', idle = true, pending = false,
  native = 'success', publish = true, freshId = 'native-fresh', listError = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-conversations-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'workspace');
  const sessionDir = path.join(root, 'sessions', '--workspace--');
  const foreignCwd = path.join(root, 'foreign');
  for (const dir of [cwd, sessionDir, foreignCwd]) fs.mkdirSync(dir, { recursive: true });
  const identityFile = path.join(root, 'primary.json');
  const outcomeFile = path.join(root, 'conversations.json');
  const env = { CODEFLARE_CHAT_PRIMARY_PID: String(process.pid + (owner ? 0 : 1)),
    CODEFLARE_CHAT_GENERATION: String(generation), CODEFLARE_CHAT_IDENTITY_FILE: identityFile };
  const hooks = new Map();
  const commands = new Map();
  const pi = {
    on(name, handler) { const handlers = hooks.get(name) ?? []; handlers.push(handler); hooks.set(name, handlers); },
    registerCommand(name, definition) { commands.set(name, definition); },
    sendUserMessage: forbidden, sendMessage: forbidden,
  };
  let active = 'native-current';
  let invalidated = false;
  let afterList;
  const entries = [
    { type: 'message', id: 'user-entry', parentId: null, message: { role: 'user', content: 'A question' } },
    { type: 'message', id: 'assistant-entry', parentId: 'user-entry', message: { role: 'assistant', content: [] } },
    { type: 'custom', id: 'metadata-entry', parentId: 'assistant-entry', customType: 'private', data: {} },
  ];
  function row(id, workspace = cwd, directory = sessionDir) {
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `2026-10-31_${id}.jsonl`);
    fs.writeFileSync(file, 'fixture: the public SDK list owns parsing\n');
    return { id, path: file, cwd: workspace, name: `Conversation ${id}`,
      created: new Date('2026-10-30T00:00:00Z'), modified: new Date('2026-10-31T00:00:00Z'),
      messageCount: 3, firstMessage: 'PRIVATE_TRANSCRIPT', allMessagesText: 'PRIVATE_TRANSCRIPT',
      parentSessionPath: '/private/parent.jsonl' };
  }
  // Ordering is deliberately unrelated to the native replacement identity.
  const rows = [row('native-older'), row('native-current'), row('metadata-newest')];
  const currentFile = () => rows.find(r => r.id === active)?.path ?? path.join(sessionDir, `${active}.jsonl`);
  const context = fresh => ({
    mode, cwd, hasUI: mode === 'tui', signal: undefined,
    isIdle: () => idle, hasPendingMessages: () => pending,
    abort: forbidden, waitForIdle: forbidden, shutdown: forbidden,
    ui: { notify() {} },
    sessionManager: {
      getSessionId() { if (!fresh && invalidated) throw new Error('Old context invalid'); return active; },
      getSessionFile() { if (!fresh && invalidated) throw new Error('Old context invalid'); return currentFile(); },
      getSessionDir() { if (!fresh && invalidated) throw new Error('Old context invalid'); return sessionDir; },
      getCwd: () => cwd,
      getEntries: () => entries,
      getBranch: () => entries,
      getEntry: id => entries.find(entry => entry.id === id),
    },
    newSession: options => replace(freshId, options),
    switchSession: (file, options) => {
      const target = rows.find(r => r.path === file);
      if (!target) throw new Error('Only SDK-listed paths can be adopted');
      return replace(target.id, options);
    },
    fork: (entryId, options) => {
      if (!entries.some(e => e.type === 'message' && e.id === entryId)) throw new Error('Invalid message');
      return replace(freshId, options);
    },
  });
  async function start(reason = 'resume') {
    for (const handler of hooks.get('session_start') ?? []) await handler({ reason }, context(true));
  }
  async function replace(id, options) {
    if (native === 'cancel') return { cancelled: true };
    if (native === 'fail') throw new Error('PRIVATE_PROVIDER_VALUE /private/path');
    active = id;
    invalidated = true;
    if (publish) await start('new');
    if (native !== 'no-fresh-context') await options?.withSession?.(context(true));
    if (native === 'terminal-race') { active = 'terminal-concurrent'; await start('resume'); }
    return { cancelled: false };
  }
  primaryIdentity(pi, env);
  primaryConversations(pi, { env, listSessions: async () => {
    if (listError) throw new Error('PRIVATE_PROVIDER_VALUE /private/path');
    await afterList?.();
    return rows;
  } });
  const request = (op, extra = {}) => ({ requestId: 'request-1', op,
    primary: { sessionId: 'native-current', generation }, ...extra });
  const invoke = async body => {
    const handler = commands.get(command)?.handler;
    assert.ok(handler, 'Reserved public command must be available to the actual primary');
    await handler(typeof body === 'string' ? body : JSON.stringify(body), context(false));
    return JSON.parse(fs.readFileSync(outcomeFile, 'utf8'));
  };
  return { pi, commands, start, request, invoke, rows, entries, cwd, sessionDir, foreignCwd,
    identityFile, outcomeFile, row, active: () => active,
    identity: () => JSON.parse(fs.readFileSync(identityFile, 'utf8')),
    afterList: fn => { afterList = fn; },
    setWorkState: state => { idle = state.idle ?? idle; pending = state.pending ?? pending; },
    terminalChange: async id => { active = id; await start('resume'); } };
}

function error(outcome, code, requestId = 'request-1') {
  assert.equal(outcome.requestId, requestId);
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.code, code);
  assert.equal(outcome.primary, undefined, 'Failure cannot grant a replacement binding');
  assert.equal(outcome.conversations, undefined);
  assert.doesNotMatch(JSON.stringify(outcome), /PRIVATE_PROVIDER_VALUE|PRIVATE_TRANSCRIPT|\/private\//);
}

function adopted(f, outcome, op, sessionId, oldIdentity) {
  assert.deepEqual(outcome, { requestId: 'request-1', op, status: 'ok',
    from: { sessionId: 'native-current', generation }, primary: f.identity() });
  assert.equal(outcome.primary.sessionId, sessionId);
  assert.equal(outcome.primary.pid, oldIdentity.pid);
  assert.equal(outcome.primary.startTime, oldIdentity.startTime);
  assert.equal(outcome.primary.generation, oldIdentity.generation);
  assert.equal(f.active(), sessionId);
  assert.equal(fs.statSync(f.outcomeFile).mode & 0o777, 0o600);
}

describe('REQ-AGENT-224 AC13–16/23: first-party primary conversation command', () => {
  for (const options of [{ owner: false }, { mode: 'rpc' }, { mode: 'print' }]) {
    it(`does not give inherited child/non-TUI resources lifecycle authority: ${JSON.stringify(options)}`, async t => {
      const f = fixture(t, options); await f.start();
      // Execute every advertised command, rather than assert registration counts.
      for (const definition of f.commands.values()) await definition.handler(JSON.stringify(f.request('new')), {});
      assert.equal(f.active(), 'native-current');
      assert.equal(fs.existsSync(f.outcomeFile), false);
    });
  }

  it('AC13 lists only authorized metadata, not transcript text, paths or another workspace', async t => {
    const f = fixture(t); await f.start(); const before = f.identity();
    f.rows.push(f.row('foreign-workspace', f.foreignCwd));
    f.rows.push(f.row('foreign-directory', f.cwd, path.join(f.foreignCwd, 'sessions')));
    const outside = f.row('symlink-target', f.cwd, f.foreignCwd);
    const link = path.join(f.sessionDir, 'linked.jsonl'); fs.symlinkSync(outside.path, link);
    f.rows.push({ ...outside, id: 'symlink-entry', path: link });
    const out = await f.invoke(f.request('list'));
    assert.deepEqual(out, { requestId: 'request-1', op: 'list', status: 'ok',
      from: { sessionId: 'native-current', generation }, primary: before,
      conversations: f.rows.slice(0, 3).map(r => ({ id: r.id, name: r.name,
        created: r.created.toISOString(), modified: r.modified.toISOString(), messageCount: r.messageCount })) });
    assert.deepEqual(f.identity(), before);
    assert.doesNotMatch(JSON.stringify(out), /PRIVATE_TRANSCRIPT|jsonl|foreign-workspace|foreign-directory|symlink-entry/);
  });

  it('AC13 permits read-only listing while the primary is busy without touching ongoing work', async t => {
    const f = fixture(t, { idle: false, pending: true }); await f.start(); const before = f.identity();
    const out = await f.invoke(f.request('list'));
    assert.equal(out.status, 'ok'); assert.equal(out.conversations.length, 3);
    assert.deepEqual(f.identity(), before); assert.equal(f.active(), before.sessionId);
  });

  it('AC13 represents empty persisted history without manufacturing a conversation', async t => {
    const f = fixture(t); await f.start(); f.rows.splice(0);
    const out = await f.invoke(f.request('list'));
    assert.equal(out.status, 'ok'); assert.deepEqual(out.conversations, []);
    assert.equal(out.primary.sessionId, 'native-current');
  });

  for (const op of ['new', 'resume', 'fork']) {
    it(`AC14–16 ${op} publishes the actual fresh adoption on the same configured carrier`, async t => {
      const f = fixture(t); await f.start(); const before = f.identity();
      const body = f.request(op, op === 'resume' ? { conversationId: 'native-older' }
        : op === 'fork' ? { entryId: 'user-entry' } : {});
      const out = await f.invoke(body);
      adopted(f, out, op, op === 'resume' ? 'native-older' : 'native-fresh', before);
      assert.notEqual(out.primary.sessionId, 'metadata-newest');
    });
    for (const native of ['cancel', 'fail']) {
      it(`AC14–16/23 ${op} ${native} leaves the old target authoritative`, async t => {
        const f = fixture(t, { native }); await f.start(); const before = f.identity();
        const out = await f.invoke(f.request(op, op === 'resume' ? { conversationId: 'native-older' }
          : op === 'fork' ? { entryId: 'user-entry' } : {}));
        if (native === 'cancel') {
          assert.deepEqual(out, { requestId: 'request-1', op, status: 'cancelled',
            from: { sessionId: 'native-current', generation } });
        } else error(out, 'NATIVE_FAILED');
        assert.deepEqual(f.identity(), before); assert.equal(f.active(), before.sessionId);
      });
    }
    for (const state of [{ idle: false }, { pending: true }]) {
      it(`AC14–16 refuses ${op} with active/queued work rather than aborting or deferring: ${JSON.stringify(state)}`, async t => {
        const f = fixture(t, state); await f.start(); const before = f.identity();
        const out = await f.invoke(f.request(op, op === 'resume' ? { conversationId: 'native-older' }
          : op === 'fork' ? { entryId: 'user-entry' } : {}));
        error(out, 'BUSY'); assert.deepEqual(f.identity(), before); assert.equal(f.active(), before.sessionId);
      });
    }
  }

  for (const primary of [{ sessionId: 'different-primary', generation },
    { sessionId: 'native-current', generation: generation - 1 }]) {
    it(`rejects stale source authority before adoption: ${JSON.stringify(primary)}`, async t => {
      const f = fixture(t); await f.start(); const before = f.identity();
      error(await f.invoke(f.request('new', { primary })), 'STALE_PRIMARY');
      assert.deepEqual(f.identity(), before); assert.equal(f.active(), before.sessionId);
    });
  }

  for (const patch of [{ cwd: '/arbitrary/workspace' }, { sessionPath: '/arbitrary/session.jsonl' },
    { conversationId: '../escape' }, { op: 'delete' }, { generation: 1 },
    { requestId: '' }, { requestId: '../result' }, { entryId: 'user-entry' }]) {
    it(`rejects extra/invalid authority and operation fields: ${JSON.stringify(patch)}`, async t => {
      const f = fixture(t); await f.start(); const before = f.identity();
      const out = await f.invoke(f.request('new', patch));
      assert.equal(out.status, 'error'); assert.equal(out.code, 'INVALID_REQUEST');
      assert.equal(out.primary, undefined); assert.deepEqual(f.identity(), before);
    });
  }

  it('rejects malformed JSON without echoing its content or treating it as a prompt', async t => {
    const f = fixture(t); await f.start(); const before = f.identity();
    const out = await f.invoke('PRIVATE_PROVIDER_VALUE not JSON');
    assert.deepEqual(out, { requestId: null, op: null, status: 'error', code: 'INVALID_REQUEST' });
    assert.deepEqual(f.identity(), before);
  });

  for (const target of ['unknown-native', '/tmp/transcript.jsonl', '../native-older']) {
    it(`AC15 never accepts a caller-selected transcript path or unknown ID: ${target}`, async t => {
      const f = fixture(t); await f.start(); const before = f.identity();
      const out = await f.invoke(f.request('resume', { conversationId: target }));
      error(out, target === 'unknown-native' ? 'NOT_FOUND' : 'INVALID_REQUEST');
      assert.deepEqual(f.identity(), before); assert.equal(f.active(), before.sessionId);
    });
  }

  for (const variant of ['foreign-cwd', 'outside-directory', 'duplicate-id']) {
    it(`AC15 requires one workspace-authorized SDK list result: ${variant}`, async t => {
      const f = fixture(t); await f.start(); const before = f.identity();
      if (variant === 'foreign-cwd') f.rows[0].cwd = f.foreignCwd;
      if (variant === 'outside-directory') f.rows[0] = f.row('native-older', f.cwd, f.foreignCwd);
      if (variant === 'duplicate-id') f.rows.push({ ...f.rows[0], path: f.rows[2].path });
      error(await f.invoke(f.request('resume', { conversationId: 'native-older' })), 'NOT_FOUND');
      assert.deepEqual(f.identity(), before); assert.equal(f.active(), before.sessionId);
    });
  }

  for (const entryId of ['unknown-message', 'metadata-entry', '../message', 'other-conversation-entry']) {
    it(`AC16 validates a current native message, not metadata or a foreign entry: ${entryId}`, async t => {
      const f = fixture(t); await f.start(); const before = f.identity();
      const out = await f.invoke(f.request('fork', { entryId }));
      error(out, entryId === '../message' ? 'INVALID_REQUEST' : 'INVALID_FORK');
      assert.deepEqual(f.identity(), before); assert.equal(f.active(), before.sessionId);
    });
  }

  it('AC16 accepts an assistant message as a current native fork point', async t => {
    const f = fixture(t); await f.start(); const before = f.identity();
    adopted(f, await f.invoke(f.request('fork', { entryId: 'assistant-entry' })), 'fork', 'native-fresh', before);
  });

  it('rechecks bound identity after asynchronous listing instead of adopting over a Terminal change', async t => {
    const f = fixture(t); await f.start();
    f.afterList(() => f.terminalChange('terminal-concurrent'));
    error(await f.invoke(f.request('resume', { conversationId: 'native-older' })), 'STALE_PRIMARY');
    assert.equal(f.identity().sessionId, 'terminal-concurrent'); assert.equal(f.active(), 'terminal-concurrent');
  });

  it('rechecks idle state after asynchronous listing, preserving work started meanwhile', async t => {
    const f = fixture(t); await f.start(); const before = f.identity();
    f.afterList(() => f.setWorkState({ idle: false }));
    error(await f.invoke(f.request('resume', { conversationId: 'native-older' })), 'BUSY');
    assert.deepEqual(f.identity(), before); assert.equal(f.active(), before.sessionId);
  });

  for (const options of [{ publish: false }, { native: 'no-fresh-context' }, { native: 'terminal-race' }]) {
    it(`AC23 cannot claim correlated adoption without fresh published identity: ${JSON.stringify(options)}`, async t => {
      const f = fixture(t, options); await f.start();
      error(await f.invoke(f.request('new')), 'UNCONFIRMED_ADOPTION');
      // Native replacement may already have happened. No rollback, guessed
      // adoption or automatic replay is authorized by this result.
      assert.equal(f.active(), options.native === 'terminal-race' ? 'terminal-concurrent' : 'native-fresh');
    });
  }

  it('AC13 list failures are redacted and leave the current conversation usable', async t => {
    const f = fixture(t, { listError: true }); await f.start(); const before = f.identity();
    error(await f.invoke(f.request('list')), 'NATIVE_FAILED'); assert.deepEqual(f.identity(), before);
  });

  it('correlates list-only outcomes to each request without implying a lifecycle change', async t => {
    const f = fixture(t); await f.start(); const before = f.identity();
    await f.invoke(f.request('list'));
    const out = await f.invoke(f.request('list', { requestId: 'request-2' }));
    assert.equal(out.requestId, 'request-2'); assert.equal(out.op, 'list');
    assert.equal(out.status, 'ok'); assert.deepEqual(out.primary, before); assert.deepEqual(f.identity(), before);
  });
});
