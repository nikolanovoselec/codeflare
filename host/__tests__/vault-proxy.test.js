// Pure prefix-transform coverage (REQ-VAULT-005 AC5) and live WebSocket
// routing through the production upgrade dispatcher (REQ-VAULT-005 AC7).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { stripVaultPrefix } from '../dist/vault-proxy.js';
import { createUpgradeDispatcher } from '../dist/upgrade-dispatcher.js';

describe('stripVaultPrefix / REQ-VAULT-005 AC5 (/vault prefix-strip before forwarding to SilverBullet)', () => {
  it('bare /vault maps to root /', () => {
    assert.equal(stripVaultPrefix('/vault'), '/');
  });

  it('trailing-slash /vault/ maps to root /', () => {
    assert.equal(stripVaultPrefix('/vault/'), '/');
  });

  it('strips the /vault prefix from a nested path', () => {
    assert.equal(stripVaultPrefix('/vault/index/foo'), '/index/foo');
  });

  it('preserves a leading dot-segment after the strip (SilverBullet client assets)', () => {
    assert.equal(stripVaultPrefix('/vault/.client/client.js'), '/.client/client.js');
  });

  it('preserves the canonical service-worker path after the strip', () => {
    assert.equal(stripVaultPrefix('/vault/service_worker.js'), '/service_worker.js');
  });

  it('does NOT strip a non-vault prefix (only the literal /vault segment)', () => {
    // "/vaulting/x" -> slice(6) -> "ing/x". This documents that the strip is a
    // raw prefix slice; the server-side guard (pathname === '/vault' ||
    // startsWith('/vault/')) is what scopes the branch, not this helper.
    assert.equal(stripVaultPrefix('/vaulting/x'), 'ing/x');
  });

  it('null pathname falls back to root / (WS upgrade with unparsable url)', () => {
    assert.equal(stripVaultPrefix(null), '/');
  });

  it('undefined pathname falls back to root /', () => {
    assert.equal(stripVaultPrefix(undefined), '/');
  });
});

// Keep both peers real: successful handshakes and byte round-trips distinguish
// routing to SilverBullet from merely accepting the downstream upgrade.
describe('Vault WebSocket dispatcher (real network peers)', () => {
  it('REQ-VAULT-005 AC7: forwards only /vault and /vault/... upgrades, never adjacent paths', { timeout: 10000 }, async (t) => {
    const savedToken = process.env.CONTAINER_AUTH_TOKEN;
    process.env.CONTAINER_AUTH_TOKEN = 'vault-dispatch-test-token';
    const upstreamWss = new WebSocketServer({ noServer: true });
    const terminalWss = new WebSocketServer({ noServer: true });
    const upstream = http.createServer();
    const downstream = http.createServer();
    const clients = new Set();
    const receivedPaths = [];
    const listen = async (server) => {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      return server.address().port;
    };
    const closeServer = (server) => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    // The dispatcher captures the target object, so configure its allocated
    // port before admitting any downstream request.
    const target = { host: '127.0.0.1', port: 0 };
    const dispatcher = createUpgradeDispatcher({
      terminalWss,
      activityTracker: { recordInput() {} },
      log() {},
      silverbullet: target,
      openvscode: { host: '127.0.0.1', port: 1 },
      wsMaxPayload: 1024 * 1024,
    });
    t.after(async () => {
      if (savedToken === undefined) delete process.env.CONTAINER_AUTH_TOKEN;
      else process.env.CONTAINER_AUTH_TOKEN = savedToken;
      for (const client of clients) { client.on('error', () => {}); client.terminate(); }
      for (const client of upstreamWss.clients) client.terminate();
      dispatcher.close();
      terminalWss.close();
      await new Promise((resolve) => upstreamWss.close(resolve));
      await Promise.all([upstream, downstream].filter((server) => server.listening).map(closeServer));
    });
    upstream.on('upgrade', (request, socket, head) => {
      upstreamWss.handleUpgrade(request, socket, head, (ws) => {
        receivedPaths.push(request.url);
        ws.on('message', (bytes, isBinary) => ws.send(bytes, { binary: isBinary }));
        ws.send('editor ready');
      });
    });
    downstream.on('upgrade', (request, socket, head) => dispatcher.handleUpgrade(request, socket, head));

    target.port = await listen(upstream);
    const port = await listen(downstream);
    const connect = (path) => {
      const client = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
        headers: { Authorization: 'Bearer vault-dispatch-test-token' },
      });
      clients.add(client);
      return client;
    };
    for (const [path, expectedUpstream] of [
      ['/vault', '/'],
      ['/vault/', '/'],
      ['/vault/.client/ws?sync=a%2Fb&empty=&sync=two+words', '/.client/ws?sync=a%2Fb&empty=&sync=two+words'],
    ]) {
      const client = connect(path);
      const [ready] = await Promise.all([once(client, 'message'), once(client, 'open')]);
      assert.equal(ready[0].toString(), 'editor ready');
      assert.equal(receivedPaths.at(-1), expectedUpstream);
      const echoed = once(client, 'message');
      const payload = Buffer.from([0, 255, 42, 13, 10]);
      client.send(payload);
      const [bytes, isBinary] = await echoed;
      assert.deepEqual(bytes, payload);
      assert.equal(isBinary, true);
      const closed = once(client, 'close');
      client.close();
      await closed;
      clients.delete(client);
    }

    for (const path of ['/vaulting', '/vaulting/ws', '/vault-other/ws', '/Vault/ws', '/other/vault/ws', '/vault%2Fws']) {
      const client = connect(path);
      try {
        const status = await new Promise((resolve, reject) => {
          client.once('unexpected-response', (_request, response) => {
            response.resume();
            resolve(response.statusCode);
          });
          client.once('open', () => resolve(101));
          client.once('error', reject);
        });
        assert.equal(status, 400, `${path} must not select the Vault proxy`);
      } finally {
        // An unexpected-response handler owns the aborted upgrade request.
        client.on('error', () => {});
        client.terminate();
        clients.delete(client);
      }
    }
    assert.deepEqual(receivedPaths, ['/', '/', '/.client/ws?sync=a%2Fb&empty=&sync=two+words'],
      'only the accepted Vault paths may reach the editor peer');
  });
});
