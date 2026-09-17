/** REQ-OPERATOR-005: production request-router bridge keeps container auth outermost. */
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { createRequestHandler } from '../dist/request-router.js';

function request(port, method, path, body, authorization) {
  const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path,
      headers: { ...(authorization ? { authorization } : {}), ...(encoded ? { 'content-length': encoded.length } : {}) } }, res => {
      let value = '';
      res.on('data', chunk => { value += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
        raw: value, body: value ? JSON.parse(value) : null }));
    });
    req.on('error', reject);
    req.end(encoded);
  });
}

test('REQ-OPERATOR-005: router authenticates then forwards fixed Pi request bytes/query and response', async t => {
  const previous = process.env.CONTAINER_AUTH_TOKEN;
  process.env.CONTAINER_AUTH_TOKEN = 'operator-host-token';
  t.after(() => { if (previous === undefined) delete process.env.CONTAINER_AUTH_TOKEN; else process.env.CONTAINER_AUTH_TOKEN = previous; });
  const calls = [];
  const operatorPi = { async handle(input) {
    calls.push(input);
    return { status: 202, headers: { 'Content-Type': 'text/html', 'X-Untrusted': '<script>alert(1)</script>' },
      body: JSON.stringify({ accepted: '<script>alert(1)</script>' }) };
  } };
  const handler = createRequestHandler({
    sessionManager: { size: 0, list: () => [] }, wsEventLog: [],
    activityTracker: { recordHeartbeat() {}, recordInput() {}, getActivityInfo: () => ({}) }, log() {},
    serverStartTime: Date.now(), readiness: () => ({ prewarmReady: true, initFlagObserved: true,
      terminalServiceReady: true, editorReady: false, editorReadyTimedOut: false }),
    silverbullet: { host: '127.0.0.1', port: 1 }, openvscode: { host: '127.0.0.1', port: 1 }, operatorPi,
  });
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.close(); await once(server, 'close'); });
  const port = server.address().port;

  const denied = await request(port, 'POST', '/internal/operator/pi/tasks?ignored=no', {}, undefined);
  assert.equal(denied.status, 401);
  assert.deepEqual(calls, []);
  const allowed = await request(port, 'POST', '/internal/operator/pi/tasks?cursor=3', { taskId: 'task-1' }, 'Bearer operator-host-token');
  assert.equal(allowed.status, 202);
  assert.deepEqual(allowed.body, { accepted: '<script>alert(1)</script>' });
  assert.doesNotMatch(allowed.raw, /<script>/);
  assert.equal(allowed.headers['cache-control'], 'no-store');
  assert.equal(allowed.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(allowed.headers['x-untrusted'], undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].pathname, '/internal/operator/pi/tasks');
  assert.equal(calls[0].query.get('cursor'), '3');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(calls[0].body)), { taskId: 'task-1' });
});

test('REQ-OPERATOR-005: ordinary host without operator composition keeps the private route unavailable', async t => {
  const previous = process.env.CONTAINER_AUTH_TOKEN;
  process.env.CONTAINER_AUTH_TOKEN = 'operator-host-token';
  t.after(() => { if (previous === undefined) delete process.env.CONTAINER_AUTH_TOKEN; else process.env.CONTAINER_AUTH_TOKEN = previous; });
  const server = http.createServer(createRequestHandler({
    sessionManager: { size: 0, list: () => [] }, wsEventLog: [],
    activityTracker: { recordHeartbeat() {}, recordInput() {}, getActivityInfo: () => ({}) }, log() {}, serverStartTime: Date.now(),
    readiness: () => ({ prewarmReady: true, initFlagObserved: true, terminalServiceReady: true, editorReady: false, editorReadyTimedOut: false }),
    silverbullet: { host: '127.0.0.1', port: 1 }, openvscode: { host: '127.0.0.1', port: 1 },
  }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.close(); await once(server, 'close'); });
  const response = await request(server.address().port, 'POST', '/internal/operator/pi/ensure', {}, 'Bearer operator-host-token');
  assert.equal(response.status, 404);
});
