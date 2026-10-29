import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { createChatProxy } from '../dist/chat-proxy.js';

const cfid = 'abcdef0123456789';
const prefix = `/api/chat/${cfid}`;
const identity = { sessionId: 'actual-primary-session', generation: 7 };
async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port;
}
function request(port, path, { method = 'GET', body, generation = '7' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method,
      headers: { 'content-type': 'application/json',
        ...(generation === null ? {} : { 'x-codeflare-chat-generation': generation }) },
    }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${prefix}/ws?generation=7`, {
    headers: { 'x-codeflare-chat-generation': '7' },
  });
  // The stock private server may send state in the same packet as its handshake.
  const ready = once(ws, 'message'); await once(ws, 'open');
  ws.initial = JSON.parse((await ready)[0].toString()); return ws;
}
function next(ws) { return once(ws, 'message').then(([data]) => JSON.parse(data.toString())); }

describe('Codeflare primary-only Chat public adapter boundary', { timeout: 15000 }, () => {
  let upstream, upstreamWss, host, chat, port, live, effects, input, adopted;
  beforeEach(async () => {
    live = identity; effects = []; input = []; adopted = false;
    upstreamWss = new WebSocketServer({ noServer: true });
    upstream = http.createServer((req, res) => {
      assert.equal(req.headers['x-pi-local-token'], 'private-backend-token');
      assert.equal(req.headers.authorization, undefined);
      const foreign = req.url.includes('foreign');
      if (req.method === 'POST') effects.push(req.url);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: req.method === 'POST' ? { transmitted: true }
        : { id: foreign ? 'foreign' : 'question-a', sessionId: foreign ? 'secondary' : identity.sessionId,
          answerable: true, origin: 'widget-bar' } }));
    });
    upstream.on('upgrade', (req, socket, head) => {
      assert.equal(req.url, '/ws');
      assert.equal(req.headers['x-pi-local-token'], 'private-backend-token');
      upstreamWss.handleUpgrade(req, socket, head, ws => {
        ws.on('message', data => {
          const msg = JSON.parse(data.toString()); effects.push(msg);
          ws.send(JSON.stringify({ type: 'event', sessionId: identity.sessionId,
            seq: effects.length, event: { type: 'fixture-receipt', message: msg } }));
        });
        ws.send(JSON.stringify({ type: 'questions_update', questions: [
          { id: 'question-a', sessionId: identity.sessionId }, { id: 'foreign', sessionId: 'secondary' },
        ] }));
        ws.send(JSON.stringify({ type: 'event', sessionId: 'secondary', event: { secret: true } }));
      });
    });
    const upstreamPort = await listen(upstream);
    chat = createChatProxy({ cfid, generation: 7, primary: () => live,
      ensurePrimary: async () => { await new Promise(resolve => setTimeout(resolve, 10));
        adopted = true; live = identity; return identity; },
      upstream: { port: upstreamPort, token: () => 'private-backend-token' },
      recordInput: () => input.push('human'),
    });
    host = http.createServer((req, res) => chat.handleHttp(req, res));
    host.on('upgrade', (req, socket, head) => chat.handleUpgrade(req, socket, head));
    port = await listen(host);
  });
  afterEach(async () => {
    chat.close();
    for (const ws of upstreamWss.clients) ws.terminate(); upstreamWss.close();
    await Promise.all([new Promise(resolve => host.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  });

  it('REQ-AGENT-224: concurrent explicit attach returns actual primary identity, with no terminal client or manual input', async () => {
    live = null;
    const results = await Promise.all(Array.from({ length: 6 }, () => request(port, `${prefix}/attach`, {
      method: 'POST', body: { generation: 7 },
    })));
    assert.ok(adopted); assert.ok(results.every(result => result.status === 200));
    for (const result of results) assert.deepEqual(result.body, identity);
    assert.deepEqual(effects, []); assert.deepEqual(input, []);
  });
  it('REQ-AGENT-224: zero is valid only as explicit trusted runtime authority; missing authority fails closed', async () => {
    chat.close(); const zero = { sessionId: identity.sessionId, generation: 0 };
    chat = createChatProxy({ cfid, generation: 0, primary: () => zero, ensurePrimary: async () => zero,
      upstream: { port: 1, token: () => '' }, recordInput() {} });
    assert.deepEqual(await request(port, `${prefix}/attach`, { method: 'POST', generation: '0', body: { generation: 0 } }),
      { status: 200, body: zero });
    chat.close(); chat = createChatProxy({ cfid, generation: null, primary: () => zero,
      ensurePrimary: async () => { throw new Error('must not start'); },
      upstream: { port: 1, token: () => '' }, recordInput() {} });
    const unavailable = await request(port, `${prefix}/attach`, { method: 'POST', body: { generation: 7 } });
    assert.equal(unavailable.status, 503); assert.match(unavailable.body.error, /CODEFLARE_CHAT_GENERATION/);
  });
  it('REQ-AGENT-224: attachment cannot select a primary, forge generation, or omit runtime authority', async () => {
    for (const [body, header] of [[{ generation: 6 }, '7'], [{ generation: 7, sessionId: 'secondary' }, '7'],
      [{ generation: 7 }, '6'], [{ generation: 7 }, null]]) {
      const result = await request(port, `${prefix}/attach`, { method: 'POST', body, generation: header });
      assert.notEqual(result.status, 200);
    }
    assert.equal(adopted, false); assert.deepEqual(effects, []);
  });
  it('REQ-AGENT-224: reads and stale/stopped WebSocket reconnect never start a primary', async () => {
    live = null;
    assert.equal((await request(port, `${prefix}/api/questions/question-a?generation=7`)).status, 409);
    const ws = new WebSocket(`ws://127.0.0.1:${port}${prefix}/ws?generation=7`, {
      headers: { 'x-codeflare-chat-generation': '7' },
    });
    ws.on('error', () => {});
    const [_request, response] = await once(ws, 'unexpected-response');
    response.resume(); ws.terminate();
    assert.equal(response.statusCode, 409); assert.equal(adopted, false);
    assert.deepEqual(effects, []); assert.deepEqual(input, []);
  });
  it('REQ-AGENT-224: proxies stock subscribe/prompt/abort only to bound primary; only manual mutations count as input', async () => {
    const ws = await connect(port);
    try {
      assert.deepEqual(ws.initial, { type: 'questions_update', questions: [
        { id: 'question-a', sessionId: identity.sessionId },
      ] });
      for (const msg of [{ type: 'subscribe', sessionId: identity.sessionId, lastSeq: 3 },
        { type: 'send_prompt', sessionId: identity.sessionId, text: 'continue the same tool', delivery: 'followUp' },
        { type: 'abort', sessionId: identity.sessionId }]) {
        const reply = next(ws); ws.send(JSON.stringify(msg));
        assert.deepEqual((await reply).event.message, msg);
      }
      assert.equal(input.length, 2);
    } finally { ws.terminate(); }
  });
  it('REQ-AGENT-224: a bounded image prompt uses the same primary without the terminal-only 64KB frame cap', async () => {
    const ws = await connect(port);
    try {
      const msg = { type: 'send_prompt', sessionId: identity.sessionId, text: 'inspect this image',
        images: [{ type: 'image', mimeType: 'image/png', data: Buffer.alloc(80 * 1024).toString('base64') }] };
      const output = next(ws); ws.send(JSON.stringify(msg));
      assert.deepEqual((await output).event.message, msg); assert.equal(input.length, 1);
    } finally { ws.terminate(); }
  });
  it('REQ-AGENT-224: closes management, foreign targets, forged provenance, malformed and binary frames without forwarding', async () => {
    for (const msg of [{ type: 'spawn_session', cwd: '/tmp' },
      { type: 'subscribe', sessionId: 'secondary' }, { type: 'abort', sessionId: 'secondary' },
      { type: 'send_prompt', sessionId: identity.sessionId, text: '/new' },
      { type: 'send_prompt', sessionId: identity.sessionId, text: 'hi', model: 'other/model' },
      { type: 'prompt_response', sessionId: identity.sessionId, promptId: 'p', answer: 'first', source: 'automatic' },
      { type: 'extension_ui_response', sessionId: identity.sessionId, requestId: 'unknown', result: 'yes' },
      '{bad json', Buffer.from('binary')]) {
      const ws = await connect(port); const closed = once(ws, 'close');
      ws.send(Buffer.isBuffer(msg) ? msg : typeof msg === 'string' ? msg : JSON.stringify(msg));
      assert.equal((await closed)[0], 1008);
    }
    assert.deepEqual(effects, []); assert.deepEqual(input, []);
  });
  it('REQ-AGENT-224: relays the stock bridge queue mirror without treating replay/buffer state as human input', async () => {
    const ws = await connect(port);
    try {
      const message = { type: 'queue_update', sessionId: identity.sessionId, steering: [], followUp: [{ text: 'pending', imageCount: 0 }] };
      const output = next(ws);
      for (const backend of upstreamWss.clients) backend.send(JSON.stringify(message));
      assert.deepEqual(await output, message); assert.deepEqual(input, []);
      const notice = { type: 'notify', sessionId: identity.sessionId, notifyId: 'notice-a',
        message: 'A useful progress notice', level: 'info', ts: 1 };
      const progress = next(ws);
      for (const backend of upstreamWss.clients) backend.send(JSON.stringify(notice));
      assert.deepEqual(await progress, notice); assert.deepEqual(input, []);
    } finally { ws.terminate(); }
  });
  it('REQ-AGENT-224: an upstream ended primary fences input rather than entering stock auto-resume', async () => {
    const ws = await connect(port); const closed = once(ws, 'close');
    for (const backend of upstreamWss.clients) backend.send(JSON.stringify({
      type: 'session_updated', sessionId: identity.sessionId, updates: { status: 'ended' },
    }));
    assert.equal((await closed)[0], 1008); assert.deepEqual(effects, []);
  });
  it('REQ-AGENT-224: revalidates identity on each frame, not just the handshake', async () => {
    const ws = await connect(port); live = { sessionId: 'replacement', generation: 7 };
    const closed = once(ws, 'close'); ws.send(JSON.stringify({ type: 'abort', sessionId: identity.sessionId }));
    assert.equal((await closed)[0], 1008); assert.deepEqual(effects, []);
  });
  it('REQ-AGENT-224: only bound primary questions can be read/answered, with no browser automatic authority', async () => {
    const result = await request(port, `${prefix}/api/questions/question-a?generation=7`);
    assert.equal(result.body.data.sessionId, identity.sessionId);
    assert.equal((await request(port, `${prefix}/api/questions/foreign?generation=7`)).status, 404);
    assert.equal((await request(port, `${prefix}/api/questions/foreign/answer?generation=7`, {
      method: 'POST', body: { answer: 'yes' },
    })).status, 404);
    assert.equal((await request(port, `${prefix}/api/questions/question-a/answer?generation=7`, {
      method: 'POST', body: { answer: 'yes', automatic: true },
    })).status, 400);
    assert.equal((await request(port, `${prefix}/api/questions/question-a/answer?generation=7`, {
      method: 'POST', body: { answer: 'yes' },
    })).status, 200);
    assert.deepEqual(effects, ['/api/questions/question-a/answer']); assert.equal(input.length, 1);
  });
});
