import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { createRequestHandler } from '../dist/request-router.js';

const path = '/internal/operator/approved-packet';
const token = 'approved-packet-route-test-token';
const metadata = () => ({ head: 'a'.repeat(40), acknowledgedHead: 'b'.repeat(40), lane: 'code-reviewer',
  deadline: Date.now() + 30_000, maxPackBytes: 1024, maxCheckoutBytes: 2048, maxOutputBytes: 128 });
const pack = Buffer.from([0, 255, 3, 128, 42]);
const headers = (value = metadata()) => ({ authorization: `Bearer ${token}`,
  'content-type': 'application/x-git-packed-objects',
  'x-codeflare-packet-input': Buffer.from(JSON.stringify(value)).toString('base64url') });

async function fixture(t, operatorPacket) {
  const previous = process.env.CONTAINER_AUTH_TOKEN;
  process.env.CONTAINER_AUTH_TOKEN = token;
  t.after(() => { if (previous === undefined) delete process.env.CONTAINER_AUTH_TOKEN;
    else process.env.CONTAINER_AUTH_TOKEN = previous; });
  const server = http.createServer(createRequestHandler({
    sessionManager: { size: 0, list: () => [] }, wsEventLog: [],
    activityTracker: { getActivityInfo: () => ({}) }, log: () => {}, serverStartTime: Date.now(),
    readiness: () => ({}), silverbullet: { host: '127.0.0.1', port: 1 },
    openvscode: { host: '127.0.0.1', port: 1 },
    ...(operatorPacket ? { operatorPacket } : {}),
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); server.close(); await once(server, 'close'); });
  return server.address().port;
}

function request(port, { method = 'POST', body = pack, requestHeaders = headers(), abort } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method,
      headers: { ...requestHeaders, ...('transfer-encoding' in requestHeaders ? {} : { 'content-length': body.length }) } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (abort) abort(req);
    else req.end(body);
  });
}

test('REQ-OPERATOR-050/053: unauthenticated packet is rejected before runner or request body I/O', async t => {
  const effects = [];
  const port = await fixture(t, { run: async () => { effects.push('run'); return pack; } });
  const result = await request(port, { requestHeaders: { ...headers(), authorization: 'Bearer wrong' },
    body: Buffer.from('malformed') });
  assert.equal(result.status, 401);
  assert.deepEqual(effects, []);
});

test('REQ-OPERATOR-050: route is absent without an injected runner', async t => {
  const port = await fixture(t);
  const result = await request(port);
  assert.equal(result.status, 404);
});

test('REQ-OPERATOR-050/053: authenticated binary pack dispatches parent-fixed metadata and returns exact bounded bytes', async t => {
  const received = [];
  const output = Buffer.from([0, 255, 1, 128]);
  const port = await fixture(t, { async run(input, { signal }) {
    received.push({ input, signal });
    return output;
  } });
  const input = metadata();
  const result = await request(port, { requestHeaders: headers(input) });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, output);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['x-content-type-options'], 'nosniff');
  assert.equal(result.headers['content-type'], 'application/octet-stream');
  assert.equal(received.length, 1);
  assert.deepEqual(Buffer.from(received[0].input.pack), pack);
  assert.deepEqual(Object.fromEntries(Object.entries(received[0].input).filter(([key]) => key !== 'pack')), input);
  assert.equal(received[0].signal instanceof AbortSignal, true);
});

test('REQ-OPERATOR-050/052: wrong method, media, malformed metadata and oversized pack deny without effects', async t => {
  const effects = [];
  const port = await fixture(t, { async run() { effects.push('run'); return pack; } });
  const invalid = [
    { method: 'GET', body: Buffer.alloc(0), status: 405 },
    { requestHeaders: { ...headers(), 'content-type': 'application/json' }, status: 415 },
    { requestHeaders: { ...headers(), 'x-codeflare-packet-input': '!!!' }, status: 400 },
    { body: Buffer.alloc(1025), status: 413 },
    { body: Buffer.alloc(1025), requestHeaders: { ...headers(), 'transfer-encoding': 'chunked' }, status: 413 },
    { requestHeaders: headers({ ...metadata(), maxOutputBytes: 0 }), status: 400 },
    { body: Buffer.alloc(0), status: 400 },
  ];
  for (const { status, ...options } of invalid) {
    const result = await request(port, options);
    assert.equal(result.status, status, JSON.stringify(options.requestHeaders));
    assert.deepEqual(effects, []);
  }
});

test('REQ-OPERATOR-050/053: caller authority fields cannot select scripts, commands, URLs or credentials', async t => {
  const effects = [];
  const port = await fixture(t, { async run() { effects.push('run'); return pack; } });
  for (const extra of [
    { scriptPath: '/tmp/candidate.js' }, { url: 'https://example.test/repo' },
    { credential: 'secret' }, { command: 'git push' }, { checkoutPath: '/tmp/other' },
  ]) {
    const result = await request(port, { requestHeaders: headers({ ...metadata(), ...extra }) });
    assert.equal(result.status, 400, JSON.stringify(extra));
    assert.deepEqual(effects, []);
  }
});

test('REQ-OPERATOR-050/053: oversized output cannot escape and runner failure has no result', async t => {
  const port = await fixture(t, { async run() { return Buffer.alloc(129, 7); } });
  const result = await request(port);
  assert.notEqual(result.status, 200);
  assert.equal(result.body.includes(Buffer.alloc(16, 7)), false);
  assert.equal(result.headers['cache-control'], 'no-store');
});

test('REQ-OPERATOR-050/054: disconnected client aborts in-flight runner without publishing a result', async t => {
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  let aborted;
  const stopped = new Promise(resolve => { aborted = resolve; });
  const port = await fixture(t, { run(_input, { signal }) {
    started();
    return new Promise(resolve => {
      signal.addEventListener('abort', () => { aborted(signal.aborted); resolve(pack); }, { once: true });
    });
  } });
  const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: {
    ...headers(), 'content-length': pack.length,
  } });
  req.on('error', () => {});
  req.end(pack);
  await entered;
  req.destroy();
  assert.equal(await stopped, true);
});
