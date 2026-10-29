import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { createRequestHandler } from '../dist/request-router.js';
import { createUpgradeDispatcher } from '../dist/upgrade-dispatcher.js';
import { createActivityTracker } from '../dist/activity-tracker.js';

// This suite owns only the existing Host routers' new optional `chat` port.
// The injected adapter stands in for the separately owned primary/stock-server
// boundary. Echoes identify which public road was selected; no adapter security,
// SDK, imported protocol, or real-primary process claim is made by these tests.
// Production supplies one chat adapter to both routers, with trusted primary()
// and ensurePrimary() callbacks. Neither callback is browser-selected.
const SID = 'abcdef0123456789';
const token = 'disposable-chat-host-bearer';
const prefix = `/api/chat/${SID}`;

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
function exchange(port, path, { authorization = `Bearer ${token}`, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path, method,
      headers: { ...(authorization === null ? {} : { authorization }), 'content-type': 'application/json' },
    }, response => {
      let text = '';
      response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode,
        body: text ? JSON.parse(text) : null }));
    });
    request.on('error', reject); request.end(body);
  });
}
async function upgrade(port, path, authorization = `Bearer ${token}`) {
  const client = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
    headers: authorization === null ? {} : { authorization },
  });
  // Install before open: the adapter's first frame may arrive with the handshake.
  const result = new Promise((resolve, reject) => {
    client.on('message', data => resolve({ status: 101, body: JSON.parse(data.toString()) }));
    client.on('unexpected-response', (_request, response) => {
      response.resume(); resolve({ status: response.statusCode, body: null });
    });
    client.on('error', error => {
      if (!error.message.includes('Unexpected server response')) reject(error);
    });
  });
  try { return await result; }
  finally { client.terminate(); }
}

describe('Codeflare Host Chat adapter composition', () => {
  let server;
  let dispatcher;
  let terminalWss;
  let chatWss;
  let deps;
  let port;
  let saved;
  beforeEach(async () => {
    saved = { token: process.env.CONTAINER_AUTH_TOKEN, session: process.env.SESSION_ID,
      mode: process.env.SESSION_MODE };
    process.env.CONTAINER_AUTH_TOKEN = token;
    process.env.SESSION_ID = SID;
    process.env.SESSION_MODE = 'advanced';
    terminalWss = new WebSocketServer({ noServer: true });
    chatWss = new WebSocketServer({ noServer: true });
    const chat = {
      async handleHttp(request, response) {
        let body = '';
        for await (const chunk of request) body += chunk.toString();
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ road: 'chat-http', path: request.url,
          method: request.method, input: body ? JSON.parse(body) : null }));
      },
      handleUpgrade(request, socket, head) {
        chatWss.handleUpgrade(request, socket, head, ws => {
          ws.send(JSON.stringify({ road: 'chat-websocket', path: request.url }));
        });
      },
    };
    deps = {
      chat, sessionManager: { list: () => [], clients: new Map(), sessions: new Map(), size: 0 },
      wsEventLog: [], activityTracker: createActivityTracker(), log() {},
      serverStartTime: Date.now(),
      readiness: () => ({ prewarmReady: false, initFlagObserved: true,
        terminalServiceReady: false, editorReady: true, editorReadyTimedOut: false }),
      silverbullet: { host: '127.0.0.1', port: 1 }, openvscode: { host: '127.0.0.1', port: 1 },
    };
    dispatcher = createUpgradeDispatcher({ ...deps, terminalWss, wsMaxPayload: 1024 * 1024 });
    server = http.createServer(createRequestHandler(deps));
    server.on('upgrade', (request, socket, head) => dispatcher.handleUpgrade(request, socket, head));
    port = await listen(server);
  });
  afterEach(async () => {
    for (const ws of chatWss.clients) ws.terminate();
    for (const ws of terminalWss.clients) ws.terminate();
    dispatcher.close();
    chatWss.close(); terminalWss.close();
    await new Promise(resolve => server.close(resolve));
    for (const [name, value] of Object.entries({ CONTAINER_AUTH_TOKEN: saved.token,
      SESSION_ID: saved.session, SESSION_MODE: saved.mode })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });

  it('REQ-AGENT-224: routes explicit HTTP attachment through the authenticated optional adapter', { timeout: 5000 }, async () => {
    const result = await exchange(port, `${prefix}/attach`, { method: 'POST', body: '{"generation":7}' });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { road: 'chat-http', path: `${prefix}/attach`,
      method: 'POST', input: { generation: 7 } });
    // Dispatch must not manufacture terminal ownership as an attachment side effect.
    const activity = await exchange(port, '/activity');
    assert.equal(activity.body.connectedClients, 0);
    assert.equal(activity.body.activeSessions, 0);
    assert.equal(activity.body.lastInputAt, null);
  });

  it('REQ-AGENT-224: component question detail and answer roads keep the exact session-scoped request', { timeout: 5000 }, async () => {
    const detail = await exchange(port, `${prefix}/api/questions/question-a?generation=7`);
    assert.deepEqual(detail, { status: 200, body: { road: 'chat-http',
      path: `${prefix}/api/questions/question-a?generation=7`, method: 'GET', input: null } });
    const answer = await exchange(port, `${prefix}/api/questions/question-a/answer?generation=7`, {
      method: 'POST', body: JSON.stringify({ answer: 'A manual answer' }),
    });
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body.input, { answer: 'A manual answer' });
    assert.equal(answer.body.path, `${prefix}/api/questions/question-a/answer?generation=7`);
  });

  it('REQ-SEC-022 / REQ-AGENT-224: rejects missing and incorrect Host bearers before dispatch', { timeout: 5000 }, async () => {
    for (const authorization of [null, 'Bearer wrong']) {
      const result = await exchange(port, `${prefix}/attach`, {
        method: 'POST', body: '{"generation":7}', authorization,
      });
      assert.equal(result.status, 401);
      assert.equal(result.body.error, 'Unauthorized');
    }
  });

  it('REQ-AGENT-224: an absent adapter fails closed rather than creating a replacement terminal', { timeout: 5000 }, async () => {
    const withoutChat = http.createServer(createRequestHandler({ ...deps, chat: undefined }));
    const otherPort = await listen(withoutChat);
    try {
      const result = await exchange(otherPort, `${prefix}/attach`, { method: 'POST', body: '{"generation":7}' });
      assert.equal(result.status, 404);
      assert.equal((await exchange(otherPort, '/activity')).body.activeSessions, 0);
    } finally { await new Promise(resolve => withoutChat.close(resolve)); }
  });

  it('REQ-AGENT-224: unrelated Host HTTP paths do not become a global Dashboard proxy', { timeout: 5000 }, async () => {
    for (const path of ['/api/settings', '/api/providers', '/api/chatty/attach']) {
      assert.equal((await exchange(port, path)).status, 404);
    }
    const ordinarySessions = await exchange(port, '/sessions');
    assert.deepEqual(ordinarySessions, { status: 200, body: { sessions: [] } });
  });

  it('REQ-AGENT-224: routes a Chat WebSocket without consuming terminal ownership or input activity', { timeout: 5000 }, async () => {
    const path = `${prefix}/ws?generation=7`;
    assert.deepEqual(await upgrade(port, path), { status: 101,
      body: { road: 'chat-websocket', path } });
    const activity = await exchange(port, '/activity');
    assert.equal(activity.body.lastInputAt, null);
    assert.equal(activity.body.connectedClients, 0);
  });

  it('REQ-SEC-022 / REQ-AGENT-224: WebSocket dispatch cannot bypass the existing container bearer gate', { timeout: 5000 }, async () => {
    assert.equal((await upgrade(port, `${prefix}/ws?generation=7`, null)).status, 401);
    assert.equal((await upgrade(port, `${prefix}/ws?generation=7`, 'Bearer wrong')).status, 401);
  });

  it('REQ-AGENT-224: unknown upgrade paths are refused, not handed to Chat or a terminal', { timeout: 5000 }, async () => {
    assert.equal((await upgrade(port, '/api/chatty/ws?generation=7')).status, 400);
    assert.equal((await upgrade(port, '/api/providers/ws')).status, 400);
  });
});
