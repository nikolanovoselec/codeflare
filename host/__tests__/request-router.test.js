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
import { VSCODE_WARMING_GIVE_UP_MS } from '../dist/vscode-proxy.js';

const UPSTREAM_BODY = '<!doctype html><title>editor</title>';

/** The rendered wait, read as the number it is rather than the sentence around it. */
function elapsedSeconds(html) {
  const match = /(\d+)s<\/p>/.exec(html);
  return match ? Number(match[1]) : undefined;
}

function hasMetaRefresh(html) {
  return /http-equiv="refresh"/.test(html);
}

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

function getText(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
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

describe('REQ-IDE-001 AC3: code-server HTTP caller routing and proxy identity', () => {
  const auth = { authorization: 'Bearer seam-test-token' };
  const savedToken = process.env.CONTAINER_AUTH_TOKEN;
  const savedMode = process.env.SESSION_MODE;
  const savedSessionId = process.env.SESSION_ID;
  const servers = [];
  const SID = 'expected-session';
  let proxyPort;
  let upstreamRequests;

  const listen = async (handler) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server.address().port;
  };

  before(async () => {
    process.env.CONTAINER_AUTH_TOKEN = 'seam-test-token';
    process.env.SESSION_MODE = 'advanced';
    process.env.SESSION_ID = SID;
    upstreamRequests = [];
    const upstreamPort = await listen((req, res) => {
      upstreamRequests.push({ url: req.url, headers: { ...req.headers } });
      res.writeHead(302, {
        Location: '/login?next=%2Fstable%2Fout%2Fmain.js',
        'Set-Cookie': [
          'code-server-session=abc; Path=/; HttpOnly',
          'code-server-scope=xyz; Path=/stable/out; HttpOnly',
        ],
        'Service-Worker-Allowed': '/',
      });
      res.end();
    });
    proxyPort = await listen(createRequestHandler(
      makeDeps({ openvscode: { host: '127.0.0.1', port: upstreamPort } }).deps,
    ));
  });

  after(async () => {
    if (savedToken === undefined) delete process.env.CONTAINER_AUTH_TOKEN;
    else process.env.CONTAINER_AUTH_TOKEN = savedToken;
    if (savedMode === undefined) delete process.env.SESSION_MODE;
    else process.env.SESSION_MODE = savedMode;
    if (savedSessionId === undefined) delete process.env.SESSION_ID;
    else process.env.SESSION_ID = savedSessionId;
    for (const server of servers) {
      server.close();
      await once(server, 'close');
    }
  });

  it('strips only the expected session prefix, preserves query bytes, and sends canonical headers', async () => {
    const query = '?resource=a%2Fb&resource=two+words&empty=&bare';
    const response = await getText(proxyPort, `/api/vscode/${SID}/stable/out/main.js${query}`, {
      ...auth,
      origin: 'https://codeflare.ch',
      forwarded: 'for=203.0.113.9;host=evil.example;proto=http',
      'x-forwarded-host': 'codeflare.ch',
      'x-forwarded-proto': 'https',
    });

    assert.equal(response.status, 302);
    assert.equal(response.headers.location, `/api/vscode/${SID}/login?next=%2Fstable%2Fout%2Fmain.js`);
    assert.deepEqual(response.headers['set-cookie'], [
      `code-server-session=abc; Path=/api/vscode/${SID}/; HttpOnly`,
      `code-server-scope=xyz; Path=/api/vscode/${SID}/stable/out; HttpOnly`,
    ]);
    assert.equal(response.headers['service-worker-allowed'], `/api/vscode/${SID}/`);
    assert.equal(upstreamRequests.length, 1);
    assert.equal(upstreamRequests[0].url, `/stable/out/main.js${query}`);
    assert.deepEqual(
      { ...upstreamRequests[0].headers, connection: undefined },
      {
        origin: 'https://codeflare.ch',
        'x-forwarded-host': 'codeflare.ch',
        'x-forwarded-proto': 'https',
        host: 'codeflare.ch',
        connection: undefined,
      },
    );
  });

  it('REQ-IDE-015 AC1+AC2: keeps the browser URL clean while selecting the fixed loopback workspace', async () => {
    const beforeCount = upstreamRequests.length;
    const response = await getText(proxyPort, `/api/vscode/${SID}/`, {
      ...auth,
      origin: 'https://codeflare.ch',
      'x-forwarded-host': 'codeflare.ch',
      'x-forwarded-proto': 'https',
    });

    assert.equal(response.status, 302);
    assert.equal(upstreamRequests.length, beforeCount + 1);
    assert.equal(upstreamRequests.at(-1).url, '/?folder=%2Fhome%2Fuser%2Fworkspace');
    assert.equal(response.headers.location, `/api/vscode/${SID}/login?next=%2Fstable%2Fout%2Fmain.js`);
  });

  it('REQ-IDE-012: rejects public workspace selectors before contacting code-server', async () => {
    for (const query of ['?folder=/etc', '?workspace=/tmp/x.code-workspace', '?ew=true', '?%66older=/etc']) {
      const beforeCount = upstreamRequests.length;
      const response = await getText(proxyPort, `/api/vscode/${SID}/${query}`, {
        ...auth,
        origin: 'https://codeflare.ch',
        'x-forwarded-host': 'codeflare.ch',
        'x-forwarded-proto': 'https',
      });
      assert.equal(response.status, 400);
      assert.equal(upstreamRequests.length, beforeCount);
    }
  });

  it('REQ-IDE-001 AC7: rejects a mismatched session prefix without contacting code-server', async () => {
    const beforeCount = upstreamRequests.length;
    const response = await getText(proxyPort, '/api/vscode/other-session/stable/out/main.js', {
      ...auth,
      origin: 'https://codeflare.ch',
      'x-forwarded-host': 'codeflare.ch',
      'x-forwarded-proto': 'https',
    });

    assert.equal(response.status, 400);
    assert.equal(upstreamRequests.length, beforeCount);
  });
});

describe('REQ-IDE-015 AC5+AC6+AC7: root workbench configuration projection', () => {
  const auth = { authorization: 'Bearer seam-test-token' };
  const savedToken = process.env.CONTAINER_AUTH_TOKEN;
  const savedMode = process.env.SESSION_MODE;
  const savedSessionId = process.env.SESSION_ID;
  const servers = [];
  const SID = 'workspace-session';
  const upstreamRequests = [];
  const logEvents = [];
  let proxyPort;

  const listen = async (handler) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server.address().port;
  };

  before(async () => {
    process.env.CONTAINER_AUTH_TOKEN = 'seam-test-token';
    process.env.SESSION_MODE = 'advanced';
    process.env.SESSION_ID = SID;
    const upstreamPort = await listen((req, res) => {
      upstreamRequests.push({ url: req.url, acceptEncoding: req.headers['accept-encoding'] });
      const body = req.headers['x-test-malformed']
        ? '<!doctype html><title>missing configuration</title>'
        : '<!doctype html><meta id="vscode-workbench-web-configuration" data-settings="{&quot;remoteAuthority&quot;:&quot;remote&quot;,&quot;productConfiguration&quot;:{&quot;nameShort&quot;:&quot;Code&quot;},&quot;opaqueServerSetting&quot;:{&quot;nested&quot;:[&quot;preserve&quot;,{&quot;value&quot;:7}]}}"><title>Code</title>';
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        ETag: 'stale-upstream-etag',
        ...(req.headers['x-test-compressed'] ? { 'Content-Encoding': 'gzip' } : {}),
      });
      res.end(body);
    });
    proxyPort = await listen(createRequestHandler(makeDeps({
      openvscode: { host: '127.0.0.1', port: upstreamPort },
      log: (level, message) => logEvents.push({ level, message }),
    }).deps));
  });

  after(async () => {
    if (savedToken === undefined) delete process.env.CONTAINER_AUTH_TOKEN;
    else process.env.CONTAINER_AUTH_TOKEN = savedToken;
    if (savedMode === undefined) delete process.env.SESSION_MODE;
    else process.env.SESSION_MODE = savedMode;
    if (savedSessionId === undefined) delete process.env.SESSION_ID;
    else process.env.SESSION_ID = savedSessionId;
    for (const server of servers) {
      server.close();
      await once(server, 'close');
    }
  });

  it('injects the private selector and projects its fixed folder into the clean browser workbench', async () => {
    const response = await getText(proxyPort, `/api/vscode/${SID}/`, {
      ...auth,
      'accept-encoding': 'gzip, br',
      'x-forwarded-host': 'codeflare.ch',
      'x-forwarded-proto': 'https',
    });

    assert.equal(response.status, 200);
    assert.deepEqual(upstreamRequests.at(-1), {
      url: '/?folder=%2Fhome%2Fuser%2Fworkspace',
      acceptEncoding: undefined,
    });
    const encoded = response.body.match(/id="vscode-workbench-web-configuration" data-settings="([^"]+)"/)?.[1];
    const config = JSON.parse(encoded.replaceAll('&quot;', '"'));
    assert.equal(config.remoteAuthority, 'remote');
    assert.deepEqual(config.folderUri, {
      scheme: 'vscode-remote',
      authority: 'codeflare.ch',
      path: '/home/user/workspace',
    });
    assert.deepEqual(config.productConfiguration, { nameShort: 'Code' });
    assert.deepEqual(config.opaqueServerSetting, { nested: ['preserve', { value: 7 }] });
    assert.equal(Number(response.headers['content-length']), Buffer.byteLength(response.body));
    assert.equal(response.headers.etag, undefined);
    assert.equal(response.headers['content-encoding'], undefined);
    assert.equal(response.headers['transfer-encoding'], undefined);
  });

  it('fails closed on an unexpectedly compressed root document', async () => {
    const response = await getText(proxyPort, `/api/vscode/${SID}/`, {
      ...auth,
      'x-test-compressed': '1',
      'x-forwarded-host': 'codeflare.ch',
      'x-forwarded-proto': 'https',
    });

    assert.equal(response.status, 502);
    assert.equal(JSON.parse(response.body).code, 'VSCODE_WORKBENCH_CONFIGURATION_INVALID');
  });

  it('fails closed instead of serving an empty workbench when the pinned HTML shape drifts', async () => {
    const response = await getText(proxyPort, `/api/vscode/${SID}/`, {
      ...auth,
      'x-test-malformed': '1',
      'x-forwarded-host': 'codeflare.ch',
      'x-forwarded-proto': 'https',
    });

    assert.equal(response.status, 502);
    assert.deepEqual(JSON.parse(response.body), {
      error: 'Browser IDE workbench configuration unavailable',
      code: 'VSCODE_WORKBENCH_CONFIGURATION_INVALID',
    });
    assert.equal(logEvents.at(-1)?.level, 'warn');
    assert.equal(logEvents.at(-1)?.message, 'Vscode workbench configuration projection failed');
    assert.doesNotMatch(JSON.stringify(logEvents), /missing configuration|data-settings/);
  });
});

// The host-side half of REQ-IDE-003 AC3. `vscodeWarmingResponse` is unit-tested
// against a given elapsed number in openvscode-proxy.test.js; what only the
// router can prove is where that number comes from. A meta refresh cannot count
// its own attempts -- each reload is a fresh document -- so the bound only
// exists if the router keeps ONE clock across an episode and drops it once the
// editor answers. Date.now is faked so crossing a 120s bound costs no wall time.
describe('REQ-IDE-003 AC3: the browser-IDE warming clock spans reloads and resets on success', () => {
  const auth = { authorization: 'Bearer seam-test-token' };
  const savedToken = process.env.CONTAINER_AUTH_TOKEN;
  const savedMode = process.env.SESSION_MODE;
  const savedSessionId = process.env.SESSION_ID;
  const realNow = Date.now;
  const servers = [];
  const workbenchBody = [
    '<!doctype html>',
    '<meta id="vscode-workbench-web-configuration"',
    ' data-settings="{&quot;remoteAuthority&quot;:&quot;codeflare.ch&quot;}">',
    '<title>Code</title>',
  ].join('');
  let now = 1_700_000_000_000;
  let refusingPort;
  let servingPort;

  const listen = async (handler) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server.address().port;
  };

  before(async () => {
    process.env.CONTAINER_AUTH_TOKEN = 'seam-test-token';
    process.env.SESSION_MODE = 'advanced';
    process.env.SESSION_ID = 'warming-session';
    Date.now = () => now;

    const upstreamPort = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(workbenchBody);
    });
    // makeDeps points OpenVSCode at port 1, which nothing ever binds, so every
    // proxied connect is refused -- the warming path, without stubbing it.
    refusingPort = await listen(createRequestHandler(makeDeps().deps));
    servingPort = await listen(createRequestHandler(
      makeDeps({ openvscode: { host: '127.0.0.1', port: upstreamPort } }).deps,
    ));
  });

  after(async () => {
    Date.now = realNow;
    if (savedToken === undefined) delete process.env.CONTAINER_AUTH_TOKEN;
    else process.env.CONTAINER_AUTH_TOKEN = savedToken;
    if (savedMode === undefined) delete process.env.SESSION_MODE;
    else process.env.SESSION_MODE = savedMode;
    if (savedSessionId === undefined) delete process.env.SESSION_ID;
    else process.env.SESSION_ID = savedSessionId;
    for (const server of servers) {
      server.close();
      await once(server, 'close');
    }
  });

  it('carries one elapsed clock across warming reloads and stops refreshing past the bound', async () => {
    const first = await getText(refusingPort, '/api/vscode/warming-session/', auth);
    assert.equal(first.status, 503);
    assert.equal(elapsedSeconds(first.body), 0);
    assert.ok(hasMetaRefresh(first.body), 'a warming page must reload itself');

    // A second reload of the same episode reports the accumulated wait, not a
    // fresh zero: the clock outlives the request that started it.
    now += 5_000;
    const later = await getText(refusingPort, '/api/vscode/warming-session/', auth);
    assert.equal(later.status, 503);
    assert.equal(elapsedSeconds(later.body), 5);

    now += VSCODE_WARMING_GIVE_UP_MS;
    const gaveUp = await getText(refusingPort, '/api/vscode/warming-session/', auth);
    assert.equal(gaveUp.status, 504);
    assert.ok(!hasMetaRefresh(gaveUp.body), 'past the bound the page must stop reloading');
  });

  it('starts a fresh clock after the editor answers, so a later cold start is not born expired', async () => {
    // Reaching the editor ends the episode whatever state the clock was in.
    const reached = await getText(servingPort, '/api/vscode/warming-session/', auth);
    assert.equal(reached.status, 200);
    assert.match(reached.body, /<title>Code<\/title>/);

    // Long enough after that success to have blown any inherited budget: the
    // next cold start must still get the full warming window, not an instant 504.
    now += 10 * VSCODE_WARMING_GIVE_UP_MS;
    const restarted = await getText(refusingPort, '/api/vscode/warming-session/', auth);
    assert.equal(restarted.status, 503);
    assert.equal(elapsedSeconds(restarted.body), 0);
    assert.ok(hasMetaRefresh(restarted.body), 'a restarted episode must reload itself again');
  });
});
