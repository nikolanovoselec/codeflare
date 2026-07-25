// Behavioral tests of the extracted HTTP request router (the server.ts
// decomposition seam). createRequestHandler is importable without booting a
// listening server — exactly what the extraction exists for — so these drive
// it through a real http.Server on an ephemeral port and assert observable
// responses. Route-specific behavior that needs the real daemon/PTY stays in
// its own suites; this file pins the router's seam contract: auth-gate
// invocation, live readiness reads, and the 404 fall-through.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createRequestHandler } from '../dist/request-router.js';

function makeDeps(overrides = {}) {
  const readiness = { prewarmReady: false, initFlagObserved: false, terminalServiceReady: false };
  return {
    readinessState: readiness,
    deps: {
      sessionManager: { size: 3, list: () => [], getOrCreate: () => null, delete: () => false },
      wsEventLog: [],
      activityTracker: {
        recordHeartbeat: () => {},
        recordInput: () => {},
        getActivityInfo: () => ({ ok: true }),
      },
      log: () => {},
      serverStartTime: Date.now(),
      readiness: () => ({ ...readiness }),
      silverbullet: { host: '127.0.0.1', port: 1 },
      openvscode: { host: '127.0.0.1', port: 1 },
      ...overrides,
    },
  };
}

function getJson(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('request router seam (server.ts decomposition)', () => {
  let server;
  let port;
  let readinessState;
  const savedToken = process.env.CONTAINER_AUTH_TOKEN;

  before(async () => {
    process.env.CONTAINER_AUTH_TOKEN = 'seam-test-token';
    const made = makeDeps();
    readinessState = made.readinessState;
    server = http.createServer(createRequestHandler(made.deps));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = server.address().port;
  });

  after(async () => {
    if (savedToken === undefined) delete process.env.CONTAINER_AUTH_TOKEN;
    else process.env.CONTAINER_AUTH_TOKEN = savedToken;
    server.close();
    await once(server, 'close');
  });

  it('routes protected paths through the REQ-SEC-022 auth gate (401 without the bearer token)', async () => {
    const { status, body } = await getJson(port, '/sessions');
    assert.equal(status, 401);
    assert.equal(body.error, 'Unauthorized');
  });

  it('serves /health auth-exempt and reads the readiness flags LIVE at request time', async () => {
    const first = await getJson(port, '/health');
    assert.equal(first.status, 200);
    assert.equal(first.body.status, 'healthy');
    assert.equal(first.body.sessions, 3);
    assert.equal(first.body.terminalServiceReady, false);

    // Flip the flags the composition root owns; the router must observe the
    // new values without being re-created (the readiness() closure contract).
    readinessState.prewarmReady = true;
    readinessState.initFlagObserved = true;
    readinessState.terminalServiceReady = true;

    const second = await getJson(port, '/health');
    assert.equal(second.body.prewarmReady, true);
    assert.equal(second.body.initFlagObserved, true);
    assert.equal(second.body.terminalServiceReady, true);
  });

  it('falls through to 404 for unknown paths (with a valid bearer token)', async () => {
    const { status, body } = await getJson(port, '/no-such-route', { authorization: 'Bearer seam-test-token' });
    assert.equal(status, 404);
    assert.equal(body.error, 'Not found');
  });
});
