// Real behavioral tests for the browser-IDE host proxy helpers (REQ-IDE-001,
// REQ-IDE-003). These pure helpers were extracted into host/src/vscode-proxy.ts
// because server.ts boots a listening server on import and cannot be imported
// into a unit test -- the same reason stripVaultPrefix/auth-check were
// extracted. We import the compiled module and assert the exact behaviour the
// server.ts /api/vscode branch relies on.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createActivityTracker } from '../dist/activity-tracker.js';
import { bridgeVscodeClientMessages, createVscodeWebSocketServer, isVscodePath, vscodeUpstreamPath, requestOpenvscodeStart, vscodeModeAllowed, vscodeWarmingResponse, vscodeDisabledResponse } from '../dist/vscode-proxy.js';

describe('isVscodePath / REQ-IDE-001 (base-path-native IDE proxy surface)', () => {
  it('matches the bare /api/vscode surface and everything below it', () => {
    assert.equal(isVscodePath('/api/vscode'), true);
    assert.equal(isVscodePath('/api/vscode/abcd1234/'), true);
    assert.equal(isVscodePath('/api/vscode/abcd1234/stable/out/main.js'), true);
  });

  it('does NOT match other proxy surfaces or a false-prefix lookalike', () => {
    assert.equal(isVscodePath('/vault/x'), false);
    assert.equal(isVscodePath('/terminal'), false);
    assert.equal(isVscodePath('/api/vscodex/y'), false); // must not match /api/vscode as a bare prefix
    assert.equal(isVscodePath('/health'), false);
  });

  it('is false for a null/undefined pathname (unparsable url)', () => {
    assert.equal(isVscodePath(null), false);
    assert.equal(isVscodePath(undefined), false);
  });
});

describe('vscodeUpstreamPath / REQ-IDE-001 (forward UNCHANGED, no strip)', () => {
  it('returns the path verbatim -- OpenVSCode is base-path native', () => {
    assert.equal(vscodeUpstreamPath('/api/vscode/abcd1234/stable/out/main.js'), '/api/vscode/abcd1234/stable/out/main.js');
    assert.equal(vscodeUpstreamPath('/api/vscode/abcd1234/'), '/api/vscode/abcd1234/');
    assert.equal(vscodeUpstreamPath('/api/vscode'), '/api/vscode');
  });

  it('does NOT strip the prefix (the load-bearing contrast with the vault)', () => {
    // A vault-style strip would return '/abcd1234/x'; the IDE MUST keep the
    // full path so OpenVSCode's --server-base-path=/api/vscode/<sid> matches.
    assert.notEqual(vscodeUpstreamPath('/api/vscode/abcd1234/x'), '/abcd1234/x');
    assert.equal(vscodeUpstreamPath('/api/vscode/abcd1234/x'), '/api/vscode/abcd1234/x');
  });

  it('falls back to /api/vscode/ for a missing pathname', () => {
    assert.equal(vscodeUpstreamPath(null), '/api/vscode/');
    assert.equal(vscodeUpstreamPath(undefined), '/api/vscode/');
  });
});

describe('requestOpenvscodeStart / REQ-IDE-003 AC2 (lazy-start trigger, idempotent)', () => {
  let triggerPath;

  beforeEach(() => {
    triggerPath = path.join(os.tmpdir(), `openvscode-trigger-test-${process.pid}`);
    try { fs.rmSync(triggerPath, { force: true }); } catch { /* ignore */ }
  });

  afterEach(() => {
    try { fs.rmSync(triggerPath, { force: true }); } catch { /* ignore */ }
  });

  it('writes the trigger file on first call and returns true', () => {
    assert.equal(fs.existsSync(triggerPath), false);
    const created = requestOpenvscodeStart(triggerPath);
    assert.equal(created, true);
    assert.equal(fs.existsSync(triggerPath), true);
  });

  it('is idempotent -- a second call does not rewrite and returns false', () => {
    requestOpenvscodeStart(triggerPath);
    const second = requestOpenvscodeStart(triggerPath);
    assert.equal(second, false);
    assert.equal(fs.existsSync(triggerPath), true);
  });
});

describe('vscodeModeAllowed / REQ-IDE-003 (advanced-mode only, fail-open when unset)', () => {
  it('allows advanced mode and fails open when SESSION_MODE is unset/empty', () => {
    assert.equal(vscodeModeAllowed('advanced'), true);
    assert.equal(vscodeModeAllowed(undefined), true); // var absent -> unchanged behaviour
    assert.equal(vscodeModeAllowed(null), true);
    assert.equal(vscodeModeAllowed(''), true);
  });

  it('blocks an explicitly non-advanced session mode', () => {
    assert.equal(vscodeModeAllowed('default'), false);
    assert.equal(vscodeModeAllowed('standard'), false);
  });
});

describe('vscodeWarmingResponse / REQ-IDE-003 AC3 (auto-refreshing warming page, not raw JSON)', () => {
  it('is a 503 HTML page that auto-refreshes so a plain tab lands on the editor once it is up', () => {
    const r = vscodeWarmingResponse();
    assert.equal(r.status, 503);
    assert.match(r.contentType, /text\/html/);
    // Contract: the page must auto-retry (a meta refresh), so the first-open tab
    // is not left on a dead error page while OpenVSCode is still binding :13337.
    assert.match(r.body, /<meta[^>]*http-equiv=["']refresh["']/i);
    // It must NOT be the old JSON error payload.
    assert.doesNotMatch(r.body, /VSCODE_WARMING/);
  });
});

describe('vscodeDisabledResponse / REQ-IDE-003 (non-advanced session: clear page, no refresh loop)', () => {
  it('is a non-2xx HTML page that does NOT auto-refresh (so a default-mode session never loops)', () => {
    const r = vscodeDisabledResponse();
    assert.equal(r.status, 409);
    assert.match(r.contentType, /text\/html/);
    // The load-bearing behavioural difference from the warming page: no meta
    // refresh, because the supervisor will never arm for a non-advanced session.
    assert.doesNotMatch(r.body, /http-equiv=["']refresh["']/i);
  });
});

describe('bridgeVscodeClientMessages / REQ-IDE-004 (early-frame delivery and IDE activity)', () => {
  function socket(state) {
    const events = new EventEmitter();
    return Object.assign(events, {
      readyState: state,
      sent: [],
      closes: [],
      send(data, options) { this.sent.push({ data: Buffer.from(data), options }); },
      close(code, reason) { this.closes.push({ code, reason }); },
    });
  }

  function assertBridgeListenersRemoved(client, upstream) {
    assert.equal(client.listenerCount('message'), 0);
    assert.equal(client.listenerCount('close'), 0);
    assert.equal(client.listenerCount('error'), 0);
    assert.equal(upstream.listenerCount('open'), 0);
    assert.equal(upstream.listenerCount('close'), 0);
    assert.equal(upstream.listenerCount('error'), 0);
  }

  it('REQ-IDE-004: delivers immediate pre-open frames in order with binary flags preserved', () => {
    const client = socket(WebSocket.OPEN);
    const upstream = socket(WebSocket.CONNECTING);

    bridgeVscodeClientMessages(client, upstream, () => {});
    client.emit('message', Buffer.from('first'), true);
    client.emit('message', Buffer.from('second'), false);
    assert.deepEqual(upstream.sent, []);

    upstream.readyState = WebSocket.OPEN;
    upstream.emit('open');
    upstream.emit('open');

    assert.deepEqual(upstream.sent.map(({ data }) => data.toString()), ['first', 'second']);
    assert.deepEqual(upstream.sent.map(({ options }) => options.binary), [true, false]);
    assert.equal(upstream.listenerCount('open'), 0);
  });

  it('REQ-IDE-004: closes with 1013 on bounded-queue overflow and releases bridge listeners', () => {
    const client = socket(WebSocket.OPEN);
    const upstream = socket(WebSocket.CONNECTING);
    const tracker = createActivityTracker();
    const originalNow = Date.now;

    try {
      Date.now = () => 100;
      bridgeVscodeClientMessages(client, upstream, () => tracker.recordInput(), 2);
      client.emit('message', Buffer.from('one'), true);
      client.emit('message', Buffer.from('two'), true);
      client.emit('message', Buffer.from('overflow'), true);

      assert.deepEqual(client.closes, [{ code: 1013, reason: 'upstream-not-ready' }]);
      assert.deepEqual(upstream.closes, [{ code: 1013, reason: 'upstream-not-ready' }]);
      assertBridgeListenersRemoved(client, upstream);
      assert.equal(tracker.getActivityInfo(null).lastInputAt, 100);

      Date.now = () => 200;
      client.emit('message', Buffer.from('after-overflow'), true);
      assert.equal(tracker.getActivityInfo(null).lastInputAt, 100);
    } finally {
      Date.now = originalNow;
    }
  });

  it('REQ-IDE-004: closes when pending frame bytes exceed the cumulative limit', () => {
    const client = socket(WebSocket.OPEN);
    const upstream = socket(WebSocket.CONNECTING);

    bridgeVscodeClientMessages(client, upstream, () => {}, 128, 4);
    client.emit('message', Buffer.alloc(3), true);
    client.emit('message', Buffer.alloc(2), true);

    assert.deepEqual(client.closes, [{ code: 1013, reason: 'upstream-not-ready' }]);
    assert.deepEqual(upstream.closes, [{ code: 1013, reason: 'upstream-not-ready' }]);
    assert.deepEqual(upstream.sent, []);
    assertBridgeListenersRemoved(client, upstream);
  });

  it('REQ-IDE-004: releases bridge listeners when either socket closes or errors', () => {
    for (const [socketName, eventName] of [
      ['client', 'close'],
      ['client', 'error'],
      ['upstream', 'close'],
      ['upstream', 'error'],
    ]) {
      const client = socket(WebSocket.OPEN);
      const upstream = socket(WebSocket.CONNECTING);
      bridgeVscodeClientMessages(client, upstream, () => {});

      const target = socketName === 'client' ? client : upstream;
      target.emit(eventName, eventName === 'error' ? new Error('socket failed') : 1000);

      assertBridgeListenersRemoved(client, upstream);
    }
  });

  it('REQ-IDE-004: advances the idle policy lastInputAt for every client-to-server frame', () => {
    const client = socket(WebSocket.OPEN);
    const upstream = socket(WebSocket.OPEN);
    const tracker = createActivityTracker();
    const originalNow = Date.now;

    try {
      Date.now = () => 100;
      bridgeVscodeClientMessages(client, upstream, () => tracker.recordInput());
      client.emit('message', Buffer.from('edit-one'), true);
      assert.equal(tracker.getActivityInfo(null).lastInputAt, 100);

      Date.now = () => 250;
      client.emit('message', Buffer.from('edit-two'), false);
      assert.equal(tracker.getActivityInfo(null).lastInputAt, 250);
    } finally {
      Date.now = originalNow;
    }
  });

  it('REQ-IDE-004: preserves immediate frames through a delayed upstream handshake', { timeout: 5000 }, async () => {
    const upstreamHttp = http.createServer();
    const upstreamWss = createVscodeWebSocketServer();
    const downstreamHttp = http.createServer();
    const downstreamWss = createVscodeWebSocketServer();
    const tracker = createActivityTracker();
    const received = [];
    let browserClient;
    let upstreamClient;

    upstreamHttp.on('upgrade', (request, socket, head) => {
      setTimeout(() => {
        upstreamWss.handleUpgrade(request, socket, head, (ws) => {
          upstreamWss.emit('connection', ws, request);
        });
      }, 75);
    });

    downstreamHttp.on('upgrade', (request, socket, head) => {
      downstreamWss.handleUpgrade(request, socket, head, (ws) => {
        downstreamWss.emit('connection', ws, request);
      });
    });

    try {
      await new Promise((resolve, reject) => {
        upstreamHttp.once('error', reject);
        upstreamHttp.listen(0, '127.0.0.1', resolve);
      });
      const upstreamPort = upstreamHttp.address().port;

      const receivedFrames = new Promise((resolve, reject) => {
        upstreamWss.once('connection', (ws) => {
          ws.once('error', reject);
          ws.on('message', (data, isBinary) => {
            received.push({ data: Buffer.from(data), isBinary });
            if (received.length === 2) resolve();
          });
        });
      });

      downstreamWss.on('connection', (clientSocket) => {
        upstreamClient = new WebSocket(`ws://127.0.0.1:${upstreamPort}`);
        bridgeVscodeClientMessages(
          clientSocket,
          upstreamClient,
          () => tracker.recordInput(),
        );
      });
      await new Promise((resolve, reject) => {
        downstreamHttp.once('error', reject);
        downstreamHttp.listen(0, '127.0.0.1', resolve);
      });
      const downstreamPort = downstreamHttp.address().port;

      browserClient = new WebSocket(`ws://127.0.0.1:${downstreamPort}`);
      await once(browserClient, 'open');
      const sentAt = Date.now();
      browserClient.send(Buffer.from('first'), { binary: true });
      browserClient.send('second');

      await receivedFrames;

      assert.deepEqual(received.map(({ data }) => data.toString()), ['first', 'second']);
      assert.deepEqual(received.map(({ isBinary }) => isBinary), [true, false]);
      assert.ok(tracker.getActivityInfo(null).lastInputAt >= sentAt);
    } finally {
      browserClient?.terminate();
      upstreamClient?.terminate();
      for (const client of downstreamWss.clients) client.terminate();
      for (const client of upstreamWss.clients) client.terminate();
      await Promise.all([
        new Promise((resolve) => downstreamWss.close(resolve)),
        new Promise((resolve) => upstreamWss.close(resolve)),
        new Promise((resolve, reject) => {
          downstreamHttp.close((error) => error ? reject(error) : resolve());
        }),
        new Promise((resolve, reject) => {
          upstreamHttp.close((error) => error ? reject(error) : resolve());
        }),
      ]);
    }
  });
});

describe('createVscodeWebSocketServer / REQ-IDE-001 (VS Code protocol payload capacity)', () => {
  it('REQ-IDE-001: accepts a 256 KiB binary protocol message intact without a 1009 close', { timeout: 5000 }, async () => {
    const proxyServer = http.createServer();
    const vscodeWss = createVscodeWebSocketServer();
    let client;

    proxyServer.on('upgrade', (req, socket, head) => {
      vscodeWss.handleUpgrade(req, socket, head, (ws) => {
        vscodeWss.emit('connection', ws, req);
      });
    });

    await new Promise((resolve, reject) => {
      proxyServer.once('error', reject);
      proxyServer.listen(0, '127.0.0.1', resolve);
    });

    try {
      const serverOutcome = new Promise((resolve) => {
        vscodeWss.once('connection', (ws) => {
          ws.once('message', (data, isBinary) => {
            ws.send(data, { binary: isBinary });
            resolve({ kind: 'message', data, isBinary });
          });
          ws.once('close', (code) => resolve({ kind: 'close', code }));
          ws.once('error', (error) => resolve({ kind: 'error', error }));
        });
      });

      const address = proxyServer.address();
      assert.ok(address && typeof address !== 'string');
      client = new WebSocket(`ws://127.0.0.1:${address.port}/api/vscode/test-session/`);
      await once(client, 'open');

      const clientOutcome = new Promise((resolve, reject) => {
        client.once('message', (data, isBinary) => resolve({ kind: 'message', data, isBinary }));
        client.once('close', (code) => resolve({ kind: 'close', code }));
        client.once('error', reject);
      });
      const payload = Buffer.alloc(256 * 1024, 0xa5);
      await new Promise((resolve, reject) => {
        client.send(payload, { binary: true }, (error) => error ? reject(error) : resolve());
      });

      const [receivedByServer, echoedToClient] = await Promise.all([serverOutcome, clientOutcome]);
      if (echoedToClient.kind === 'close') {
        assert.notEqual(echoedToClient.code, 1009, 'the proxy rejected a valid VS Code protocol payload as too large');
      }
      assert.equal(receivedByServer.kind, 'message');
      assert.equal(receivedByServer.isBinary, true);
      assert.deepEqual(Buffer.from(receivedByServer.data), payload);
      assert.equal(echoedToClient.kind, 'message');
      assert.equal(echoedToClient.isBinary, true);
      assert.deepEqual(Buffer.from(echoedToClient.data), payload);

      const clientClosed = once(client, 'close');
      client.close(1000, 'test-complete');
      const [closeCode] = await clientClosed;
      assert.equal(closeCode, 1000);
    } finally {
      if (client && client.readyState !== WebSocket.CLOSED) client.terminate();
      for (const ws of vscodeWss.clients) ws.terminate();
      await new Promise((resolve) => vscodeWss.close(resolve));
      await new Promise((resolve, reject) => {
        proxyServer.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});
