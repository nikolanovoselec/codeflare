// Behavioral coverage for the Browser IDE WebSocket caller. This drives the
// real upgrade dispatcher through downstream and upstream HTTP servers so path,
// query, and proxy-header assertions describe the observable code-server hop.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { createUpgradeDispatcher } from '../dist/upgrade-dispatcher.js';

const SID = 'expected-session';

describe('REQ-IDE-001 AC3: code-server WebSocket caller routing and proxy identity', () => {
  const savedMode = process.env.SESSION_MODE;
  const savedSessionId = process.env.SESSION_ID;
  const savedToken = process.env.CONTAINER_AUTH_TOKEN;
  const servers = [];
  const upstreamWss = new WebSocketServer({ noServer: true });
  const terminalWss = new WebSocketServer({ noServer: true });
  const upstreamRequests = [];
  let dispatcher;
  let proxyPort;

  const listen = async (server) => {
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server.address().port;
  };

  before(async () => {
    process.env.SESSION_MODE = 'advanced';
    process.env.SESSION_ID = SID;
    process.env.CONTAINER_AUTH_TOKEN = 'browser-ide-test-token';

    const upstreamServer = http.createServer();
    upstreamServer.on('upgrade', (request, socket, head) => {
      upstreamWss.handleUpgrade(request, socket, head, (ws) => {
        upstreamRequests.push({ url: request.url, headers: { ...request.headers } });
        upstreamWss.emit('connection', ws, request);
      });
    });
    const upstreamPort = await listen(upstreamServer);

    const proxyServer = http.createServer();
    dispatcher = createUpgradeDispatcher({
      terminalWss,
      activityTracker: { recordInput() {} },
      log() {},
      silverbullet: { host: '127.0.0.1', port: 1 },
      openvscode: { host: '127.0.0.1', port: upstreamPort },
      wsMaxPayload: 1024 * 1024,
    });
    proxyServer.on('upgrade', (request, socket, head) => {
      dispatcher.handleUpgrade(request, socket, head);
    });
    proxyPort = await listen(proxyServer);
  });

  after(async () => {
    if (savedMode === undefined) delete process.env.SESSION_MODE;
    else process.env.SESSION_MODE = savedMode;
    if (savedSessionId === undefined) delete process.env.SESSION_ID;
    else process.env.SESSION_ID = savedSessionId;
    if (savedToken === undefined) delete process.env.CONTAINER_AUTH_TOKEN;
    else process.env.CONTAINER_AUTH_TOKEN = savedToken;

    for (const ws of upstreamWss.clients) ws.terminate();
    dispatcher.close();
    terminalWss.close();
    await new Promise((resolve) => upstreamWss.close(resolve));
    for (const server of servers) {
      server.close();
      await once(server, 'close');
    }
  });

  it('strips only the expected session prefix and preserves reconnect query bytes and canonical headers', { timeout: 5000 }, async () => {
    const query = '?reconnect=a%2Fb&reconnect=two+words&empty=&bare';
    const client = new WebSocket(
      `ws://127.0.0.1:${proxyPort}/api/vscode/${SID}/ws${query}`,
      {
        headers: {
          Authorization: 'Bearer browser-ide-test-token',
          Origin: 'https://codeflare.ch',
          Forwarded: 'for=203.0.113.9;host=evil.example;proto=http',
          'X-Forwarded-Host': 'codeflare.ch',
          'X-Forwarded-Proto': 'https',
        },
      },
    );

    try {
      await once(client, 'open');
      assert.equal(upstreamRequests.length, 1);
      const observed = upstreamRequests[0];
      assert.equal(observed.url, `/ws${query}`);
      assert.equal(observed.headers.origin, 'https://codeflare.ch');
      assert.equal(observed.headers.host, 'codeflare.ch');
      assert.equal(observed.headers['x-forwarded-host'], 'codeflare.ch');
      assert.equal(observed.headers['x-forwarded-proto'], 'https');
      assert.equal(observed.headers.forwarded, undefined);
      assert.equal(observed.headers.authorization, undefined);
    } finally {
      client.terminate();
    }
  });

  it('REQ-SEC-022: rejects a missing container bearer before opening a code-server socket', { timeout: 5000 }, async () => {
    const beforeCount = upstreamRequests.length;
    const client = new WebSocket(
      `ws://127.0.0.1:${proxyPort}/api/vscode/${SID}/ws`,
      {
        headers: {
          Origin: 'https://codeflare.ch',
          'X-Forwarded-Host': 'codeflare.ch',
          'X-Forwarded-Proto': 'https',
        },
      },
    );

    const status = await new Promise((resolve, reject) => {
      client.once('unexpected-response', (_request, response) => {
        response.resume();
        resolve(response.statusCode);
      });
      client.once('open', () => resolve(101));
      client.once('error', (error) => {
        if (error.message.includes('Unexpected server response')) return;
        reject(error);
      });
    });

    client.terminate();
    assert.equal(status, 401);
    assert.equal(upstreamRequests.length, beforeCount);
  });

  it('rejects a mismatched session prefix before opening a code-server socket', { timeout: 5000 }, async () => {
    const beforeCount = upstreamRequests.length;
    const client = new WebSocket(
      `ws://127.0.0.1:${proxyPort}/api/vscode/other-session/ws`,
      {
        headers: {
          Authorization: 'Bearer browser-ide-test-token',
          Origin: 'https://codeflare.ch',
          'X-Forwarded-Host': 'codeflare.ch',
          'X-Forwarded-Proto': 'https',
        },
      },
    );

    const status = await new Promise((resolve, reject) => {
      client.once('unexpected-response', (_request, response) => {
        response.resume();
        resolve(response.statusCode);
      });
      client.once('open', () => resolve(101));
      client.once('error', (error) => {
        if (error.message.includes('Unexpected server response')) return;
        reject(error);
      });
    });

    client.terminate();
    assert.equal(status, 400);
    assert.equal(upstreamRequests.length, beforeCount);
  });
});
