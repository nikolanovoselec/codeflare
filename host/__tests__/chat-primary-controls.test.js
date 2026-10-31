import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPrimaryConversations } from '../dist/chat-primary-controls.js';

// First-party coordinator only: real private outcome files, owned command wire,
// trusted identity publication and stock-registration proof supplied at the seam.
// Authored before implementation; no executed RED evidence is claimed.
const source = { sessionId: 'source', generation: 7, pid: 123, startTime: '456', paneId: 'pane-a' };
const bound = { sessionId: source.sessionId, generation: source.generation };
const bare = identity => ({ sessionId: identity.sessionId, generation: identity.generation });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const code = expected => error => error.code === expected && error.message === expected;

describe('REQ-AGENT-224 AC13–16/23: actual-primary conversation coordination', () => {
  let runtimeDir, live, port, receive, proof, commands;
  beforeEach(async () => {
    runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-primary-controls-'));
    await fs.chmod(runtimeDir, 0o700);
    live = { ...source };
    commands = [];
    proof = async expected => { assert.deepEqual(expected, live); return bare(live); };
    receive = async request => outcome(request, { status: 'ok', primary: live });
    port = make();
  });
  afterEach(async () => { await fs.rm(runtimeDir, { recursive: true, force: true }); });
  function make(budgetMs = 200) {
    return createPrimaryConversations({ runtimeDir, budgetMs, readIdentity: () => live,
      confirm: expected => proof(expected),
      dispatch: async (carrier, text) => {
        assert.deepEqual(carrier, source);
        assert.ok(text.startsWith('/codeflare-conversation '));
        const request = JSON.parse(text.slice('/codeflare-conversation '.length));
        assert.match(request.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        const extra = request.op === 'resume' ? ['conversationId'] : request.op === 'fork' ? ['entryId'] : [];
        assert.deepEqual(Object.keys(request).sort(), ['requestId', 'op', 'primary', ...extra].sort());
        assert.deepEqual(request.primary, bound);
        commands.push(request);
        await receive(request);
      },
    });
  }
  async function outcome(request, fields) {
    const temporary = path.join(runtimeDir, 'pending');
    await fs.writeFile(temporary, JSON.stringify({ requestId: request.requestId, op: request.op,
      from: request.primary, ...fields }), { mode: 0o600 });
    await fs.rename(temporary, path.join(runtimeDir, 'conversations.json'));
  }

  for (const [op, argument] of [['new'], ['resume', 'requested-older'], ['fork', 'message-1']]) {
    it(`${op} uses the exact private command and returns only the correlated actual adoption`, async () => {
      receive = async request => {
        assert.equal(request.op, op);
        if (argument) assert.equal(request[op === 'resume' ? 'conversationId' : 'entryId'], argument);
        // The requested ID is deliberately NOT the outcome's target.
        live = { ...source, sessionId: 'actual-adopted' };
        await outcome(request, { status: 'ok', primary: { ...live, path: '/secret' } });
      };
      assert.deepEqual(await port[op](bound, argument), { sessionId: 'actual-adopted', generation: 7 });
    });
  }
  it('lists in native order, even while native work is busy, and allowlists metadata without rebinding', async () => {
    const rows = [
      { id: 'older', name: 'Earlier work', created: '2026-01-01T00:00:00.000Z', modified: '2026-02-01T00:00:00.000Z', messageCount: 3 },
      { id: 'empty', created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z', messageCount: 0 },
    ];
    receive = request => outcome(request, { status: 'ok', primary: live, busy: true,
      conversations: rows.map(row => ({ ...row, path: '/secret', cwd: '/workspace', firstMessage: 'private transcript', allMessagesText: 'secret', pid: 123 })) });
    assert.deepEqual(await port.list(bound), rows);
    assert.deepEqual(live, source);
    receive = request => outcome(request, { status: 'ok', primary: live, conversations: [] });
    assert.deepEqual(await port.list(bound), []);
  });
  it('ignores a different nonce until the matching outcome arrives', async () => {
    const written = deferred();
    receive = async request => {
      await outcome({ ...request, requestId: 'other-nonce' }, { status: 'error', code: 'NOT_FOUND' });
      written.resolve(request);
    };
    const pending = port.new(bound).then(value => ({ value }), error => ({ error }));
    const request = await written.promise;
    await new Promise(resolve => setTimeout(resolve, 35));
    await outcome(request, { status: 'ok', primary: live });
    assert.deepEqual(await pending, { value: bound });
  });
  for (const fields of [{ op: 'fork' }, { from: { sessionId: 'foreign', generation: 7 } }, { from: { ...bound, generation: 8 } }]) {
    it(`rejects a correlated outcome with wrong operation/source: ${JSON.stringify(fields)}`, async () => {
      receive = request => outcome(request, { status: 'ok', primary: live, ...fields });
      await assert.rejects(port.new(bound), code('UNCONFIRMED_ADOPTION'));
    });
  }
  for (const changed of [{ pid: 999 }, { startTime: '999' }, { generation: 8 }, { paneId: 'different-pane' }]) {
    it(`never adopts a replaced native carrier: ${JSON.stringify(changed)}`, async () => {
      receive = async request => {
        live = { ...source, sessionId: 'new', ...changed };
        await outcome(request, { status: 'ok', primary: live });
      };
      await assert.rejects(port.new(bound), code('STALE_PRIMARY'));
    });
  }
  it('does not infer success from a changed actual ID without correlated outcome', async () => {
    port = make(35);
    receive = async () => { live = { ...source, sessionId: 'terminal-change' }; };
    await assert.rejects(port.resume(bound, 'requested'), code('CONVERSATION_PENDING'));
    assert.deepEqual(commands.map(row => row.op), ['resume']); // wire history: never replay an uncertain operation
  });
  it('requires the outcome to match the actual published session, not a plausible requested target', async () => {
    receive = request => outcome(request, { status: 'ok', primary: { ...source, sessionId: 'requested' } });
    await assert.rejects(port.resume(bound, 'requested'), code('UNCONFIRMED_ADOPTION'));
  });
  it('requires matching stock registration proof', async () => {
    proof = async () => ({ sessionId: 'unrelated-stock-row', generation: 7 });
    await assert.rejects(port.new(bound), code('UNCONFIRMED_ADOPTION'));
  });
  it('rechecks actual identity after awaiting stock confirmation', async () => {
    proof = async expected => { live = { ...source, sessionId: 'terminal-wins' }; return bare(expected); };
    await assert.rejects(port.new(bound), code('UNCONFIRMED_ADOPTION'));
  });
  it('list never grants a replacement binding', async () => {
    receive = async request => {
      live = { ...source, sessionId: 'changed' };
      await outcome(request, { status: 'ok', primary: live, conversations: [] });
    };
    await assert.rejects(port.list(bound), code('STALE_PRIMARY'));
  });
  it('rejects stale bound authority before emitting native commands', async () => {
    live = { ...source, sessionId: 'other' };
    await assert.rejects(port.new(bound), code('STALE_PRIMARY'));
    assert.deepEqual(commands, []);
  });
  it('rejects concurrent requests as BUSY rather than queuing another command', async () => {
    const entered = deferred(); const release = deferred();
    receive = async request => { entered.resolve(); await release.promise; await outcome(request, { status: 'ok', primary: live }); };
    const first = port.new(bound);
    await entered.promise;
    await assert.rejects(port.resume(bound, 'older'), code('BUSY'));
    release.resolve();
    assert.deepEqual(await first, bound);
    assert.deepEqual(commands.map(row => row.op), ['new']);
  });
  it('bounds stock confirmation as well as outcome waiting without resending', async () => {
    port = make(35);
    proof = () => new Promise(() => {});
    await assert.rejects(port.new(bound), code('CONVERSATION_PENDING'));
    assert.deepEqual(commands.map(row => row.op), ['new']);
  });
  it('cancellation grants no replacement and permits a later explicit request', async () => {
    receive = request => outcome(request, { status: 'cancelled', primary: { ...source, sessionId: 'fake' } });
    await assert.rejects(port.new(bound), code('CONVERSATION_CANCELLED'));
    assert.deepEqual(live, source);
    receive = request => outcome(request, { status: 'ok', primary: live });
    assert.deepEqual(await port.new(bound), bound);
    assert.notEqual(commands[0].requestId, commands[1].requestId);
  });
  for (const nativeCode of ['BUSY', 'STALE_PRIMARY', 'NOT_FOUND', 'INVALID_FORK', 'NATIVE_FAILED', 'UNCONFIRMED_ADOPTION', 'unsafe /secret exception']) {
    it(`exposes only sanitized native failure code: ${nativeCode}`, async () => {
      receive = request => outcome(request, { status: 'error', code: nativeCode, message: 'secret exception /path' });
      await assert.rejects(port.new(bound), code(nativeCode.startsWith('unsafe') ? 'NATIVE_FAILED' : nativeCode));
    });
  }
  it('rejects malformed metadata rather than leaking native JSON', async () => {
    receive = request => outcome(request, { status: 'ok', primary: live,
      conversations: [{ id: '../private', messageCount: -1, created: 'not a date', path: '/secret' }] });
    await assert.rejects(port.list(bound), code('NATIVE_FAILED'));
  });
  it('does not consume an oversized outcome', async () => {
    receive = () => fs.writeFile(path.join(runtimeDir, 'conversations.json'), ' '.repeat(8 * 1024 * 1024 + 1), { mode: 0o600 });
    await assert.rejects(port.new(bound), code('CONVERSATION_UNAVAILABLE'));
  });
  it('refuses an outcome symlink even if it contains a matching success', async () => {
    receive = async request => {
      await fs.writeFile(path.join(runtimeDir, 'foreign'), JSON.stringify({ requestId: request.requestId, op: request.op,
        from: bound, status: 'ok', primary: live }), { mode: 0o600 });
      await fs.symlink(path.join(runtimeDir, 'foreign'), path.join(runtimeDir, 'conversations.json'));
    };
    await assert.rejects(port.new(bound), code('CONVERSATION_UNAVAILABLE'));
  });
});
