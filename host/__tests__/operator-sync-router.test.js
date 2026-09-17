/** REQ-OPERATOR-023: authenticated production sync bridge and ordinary-bisync exclusion. */
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { createRequestHandler } from '../dist/request-router.js';

function deps(operatorSync) {
  return { sessionManager: { size: 0, list: () => [] }, wsEventLog: [],
    activityTracker: { recordHeartbeat() {}, recordInput() {}, getActivityInfo: () => ({}) }, log() {}, serverStartTime: Date.now(),
    readiness: () => ({ prewarmReady: true, initFlagObserved: true, terminalServiceReady: true, editorReady: false, editorReadyTimedOut: false }),
    silverbullet: { host: '127.0.0.1', port: 1 }, openvscode: { host: '127.0.0.1', port: 1 }, ...(operatorSync ? { operatorSync } : {}) };
}
function request(port, path, authorization) {
  const body = Buffer.from('{}');
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: {
      ...(authorization ? { authorization } : {}), 'content-length': body.length } }, res => {
      let value = ''; res.on('data', chunk => { value += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: value ? JSON.parse(value) : null }));
    });
    req.on('error', reject); req.end(body);
  });
}

test('REQ-OPERATOR-023: router authenticates before forwarding fixed explicit-sync requests', async t => {
  const previous = process.env.CONTAINER_AUTH_TOKEN;
  process.env.CONTAINER_AUTH_TOKEN = 'host-token';
  t.after(() => { if (previous === undefined) delete process.env.CONTAINER_AUTH_TOKEN; else process.env.CONTAINER_AUTH_TOKEN = previous; });
  const calls = [];
  const operatorSync = { async handle(input) { calls.push(input); return { status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ status: 'uploaded' }) }; } };
  const server = http.createServer(createRequestHandler(deps(operatorSync)));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.close(); await once(server, 'close'); });
  const port = server.address().port;
  assert.equal((await request(port, '/internal/operator/sync/operations', undefined)).status, 401);
  assert.deepEqual(calls, []);
  assert.equal((await request(port, '/internal/operator/sync/operations', 'Bearer host-token')).status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(calls[0].body)), {});
});

test('REQ-OPERATOR-023: restricted host blocks ordinary bisync/final-sync routes while ordinary host is unchanged', async t => {
  const previous = process.env.CONTAINER_AUTH_TOKEN;
  process.env.CONTAINER_AUTH_TOKEN = 'host-token';
  t.after(() => { if (previous === undefined) delete process.env.CONTAINER_AUTH_TOKEN; else process.env.CONTAINER_AUTH_TOKEN = previous; });
  const operatorSync = { async handle() { return null; } };
  const restricted = http.createServer(createRequestHandler(deps(operatorSync)));
  restricted.listen(0, '127.0.0.1'); await once(restricted, 'listening');
  t.after(async () => { restricted.close(); await once(restricted, 'close'); });
  const port = restricted.address().port;
  for (const path of ['/internal/bisync-trigger', '/internal/final-sync']) {
    const response = await request(port, path, 'Bearer host-token');
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'OPERATOR_BISYNC_DENIED');
  }
});
