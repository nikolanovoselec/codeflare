import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { createChatProxy } from '../dist/chat-proxy.js';

// Changed Codeflare boundary only. The pinned browser-protocol wire contract is
// intentional: accepted controls must reach the bound primary unchanged, and
// their native responses must remain usable. No donor widget/queue/SDK tests.
const cfid = 'abcdef0123456789';
const primary = { sessionId: 'bound-primary', generation: 7 };
const model = { provider: 'codeflare-gateway', id: 'route-fast', name: 'Fast route', contextWindow: 128000 };
const controls = [
  { type: 'request_models' },
  { type: 'set_model', provider: model.provider, modelId: model.id },
  { type: 'set_thinking_level', level: 'high' },
  { type: 'request_commands' },
  { type: 'list_files', query: 'src/chat' },
  { type: 'edit_followup_entry', index: 0, text: 'Revised follow-up' },
  { type: 'remove_followup_entry', index: 0 },
  { type: 'promote_followup_entry', index: 1 },
  { type: 'clear_followup_entries', indices: 'all' },
  { type: 'clear_followup_entries', indices: [0, 2] },
  { type: 'retry_session' },
  { type: 'force_kill' },
  { type: 'stop_after_turn' },
  { type: 'setSessionDisplayPrefs', override: {
    reasoning: true, contextUsageBar: true, toolCalls: { read: false }, chatMotion: false,
  } },
  { type: 'setSessionDisplayPrefs', override: null },
];
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
function response(ws) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      ws.off('message', message);
      ws.off('close', closed);
      ws.off('error', failed);
    };
    const message = bytes => { cleanup(); resolve(JSON.parse(bytes.toString())); };
    const closed = code => { cleanup(); reject(new Error(`Chat closed before its control response (${code})`)); };
    const failed = error => { cleanup(); reject(error); };
    ws.once('message', message);
    ws.once('close', closed);
    ws.once('error', failed);
  });
}

describe('REQ-AGENT-224 complete Chat control boundary', { timeout: 15000 }, () => {
  let upstream, upstreamWss, host, chat, port, observed;
  beforeEach(async () => {
    observed = [];
    upstreamWss = new WebSocketServer({ noServer: true });
    upstream = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
    upstream.on('upgrade', (req, socket, head) => {
      assert.equal(req.url, '/ws');
      upstreamWss.handleUpgrade(req, socket, head, ws => {
        ws.on('message', bytes => {
          const message = JSON.parse(bytes.toString());
          observed.push(message);
          ws.send(JSON.stringify({ type: 'notify', sessionId: primary.sessionId,
            level: 'info', message: 'Control accepted by primary' }));
        });
      });
    });
    const upstreamPort = await listen(upstream);
    chat = createChatProxy({ cfid, generation: 7, primary: () => primary,
      ensurePrimary: async () => primary, recordInput() {},
      upstream: { port: upstreamPort, token: () => 'fixture-private-token' } });
    host = http.createServer((req, res) => chat.handleHttp(req, res));
    host.on('upgrade', (req, socket, head) => chat.handleUpgrade(req, socket, head));
    port = await listen(host);
  });
  afterEach(async () => {
    chat.close();
    for (const ws of upstreamWss.clients) ws.terminate();
    upstreamWss.close();
    await Promise.all([new Promise(resolve => host.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  });
  async function connect() {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/chat/${cfid}/ws?generation=7`, {
      headers: { 'x-codeflare-chat-generation': '7' },
    });
    await once(ws, 'open');
    return ws;
  }

  for (const control of controls) {
    it(`pinned control wire contract: ${control.type} ${JSON.stringify(control.indices ?? '')} reaches only the bound primary`, async () => {
      const ws = await connect();
      const nativeResponse = response(ws);
      const message = { ...control, sessionId: primary.sessionId };
      ws.send(JSON.stringify(message));
      assert.equal((await nativeResponse).message, 'Control accepted by primary');
      assert.deepEqual(observed, [message]);
      ws.terminate();
    });
  }

  for (const nativeResponse of [
    { type: 'models_list', models: [model] },
    { type: 'commands_list', commands: [{ name: 'compact', description: 'Compact context' }] },
    { type: 'files_list', query: 'src/chat', files: [{ path: 'src/chat/api.ts', type: 'file' }] },
    { type: 'force_kill_result', success: true },
    { type: 'flows_list', flows: [{ name: 'review-task', description: 'Review current work' }] },
    { type: 'error', message: 'Model selection denied by policy' },
  ]) {
    it(`pinned response wire contract: ${nativeResponse.type} is usable without exposing another primary`, async () => {
      const ws = await connect();
      const receipt = response(ws);
      const message = { ...nativeResponse, sessionId: primary.sessionId };
      for (const backend of upstreamWss.clients) {
        backend.send(JSON.stringify({ ...nativeResponse, sessionId: 'foreign-primary' }));
        backend.send(JSON.stringify(message));
      }
      assert.deepEqual(await receipt, message);
      ws.terminate();
    });
  }

  it('discovered-command wire contract executes only safe advertised commands on the bound primary', async () => {
    const ws = await connect();
    const catalog = response(ws);
    for (const backend of upstreamWss.clients) backend.send(JSON.stringify({ type: 'commands_list', sessionId: primary.sessionId,
      commands: [{ name: 'compact', description: 'Compact context' }, { name: 'plan', description: 'Plan task' },
        { name: 'new' }, { name: 'NEW' }, { name: 'view' }, { name: 'flows:new' }, { name: 'flows:edit' },
        { name: 'flows:delete' }, { name: '__dashboard_retry' }, { name: 'dashboard-connect' }, { name: 'codeflare-conversation' }] }));
    assert.deepEqual((await catalog).commands, [
      { name: 'compact', description: 'Compact context' }, { name: 'plan', description: 'Plan task' },
    ]);
    const accepted = response(ws);
    const message = { type: 'send_prompt', sessionId: primary.sessionId, text: '/plan focus this task' };
    ws.send(JSON.stringify(message));
    assert.equal((await accepted).message, 'Control accepted by primary');
    assert.deepEqual(observed, [message]);
    ws.terminate();
  });
  it('advertises executable flows without exposing flow-management aliases', async () => {
    const ws = await connect();
    const catalog = response(ws);
    for (const backend of upstreamWss.clients) backend.send(JSON.stringify({ type: 'flows_list', sessionId: primary.sessionId,
      flows: [{ name: 'review-task' }, { name: 'new' }, { name: 'edit' }, { name: 'delete' }] }));
    assert.deepEqual((await catalog).flows, [{ name: 'review-task' }]);
    ws.terminate();
  });

  it('reserved lifecycle commands cannot be smuggled through ordinary browser prompt dispatch', async () => {
    const ws = await connect();
    const catalog = response(ws);
    for (const backend of upstreamWss.clients) backend.send(JSON.stringify({ type: 'commands_list', sessionId: primary.sessionId,
      commands: [{ name: 'codeflare-conversation' }] }));
    await catalog;
    const closed = once(ws, 'close');
    ws.send(JSON.stringify({ type: 'send_prompt', sessionId: primary.sessionId, text: '/codeflare-conversation {}' }));
    assert.equal((await closed)[0], 1008);
    assert.deepEqual(observed, []);
  });

  for (const control of controls) {
    it(`rejects a foreign target for newly exposed ${control.type}`, async () => {
      const ws = await connect();
      const closed = once(ws, 'close');
      ws.send(JSON.stringify({ ...control, sessionId: 'foreign-primary' }));
      assert.equal((await closed)[0], 1008);
      assert.deepEqual(observed, []);
    });
  }

  for (const invalid of [
    { type: 'request_models', cwd: '/foreign' },
    { type: 'request_commands', includeGlobal: true },
    { type: 'set_model', provider: '', modelId: model.id },
    { type: 'set_model', provider: model.provider, modelId: '' },
    { type: 'set_thinking_level', level: 'unsupported' },
    { type: 'list_files', query: '../foreign' },
    { type: 'list_files', query: '/etc/passwd' },
    { type: 'list_files', query: 'src', cwd: '/foreign' },
    { type: 'edit_followup_entry', index: -1, text: 'Changed' },
    { type: 'edit_followup_entry', index: 0, text: 12 },
    { type: 'remove_followup_entry', index: 0.5 },
    { type: 'promote_followup_entry', index: -1 },
    { type: 'clear_followup_entries', indices: [0, -1] },
    { type: 'clear_followup_entries', indices: 'everything' },
    { type: 'force_kill', pgid: 123 },
    { type: 'stop_after_turn', sessionIds: ['foreign-primary'] },
    { type: 'retry_session', force: true },
    { type: 'setSessionDisplayPrefs', override: { provider: 'foreign' } },
    { type: 'setSessionDisplayPrefs', override: { reasoning: 'yes' } },
    { type: 'setSessionDisplayPrefs', override: { toolCalls: { read: 'yes' } } },
    { type: 'setSessionDisplayPrefs', override: { reasoningAutoCollapseMs: -1 } },
    { type: 'setSessionDisplayPrefs', override: { notifyMinLevel: 'off' } },
    { type: 'setSessionDisplayPrefs', override: JSON.parse('{"__proto__":{"polluted":true}}') },
  ]) {
    it(`rejects malformed or widened ${invalid.type} controls before protected dispatch`, async () => {
      const ws = await connect();
      const closed = once(ws, 'close');
      ws.send(JSON.stringify({ ...invalid, sessionId: primary.sessionId }));
      assert.equal((await closed)[0], 1008);
      assert.deepEqual(observed, []);
    });
  }
});
