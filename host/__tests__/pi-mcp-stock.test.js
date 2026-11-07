// Historical filename retained. Managed CI/image only: real, unmodified adapter and Pi SDK.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
async function until(predicate) {
  // Real bounded scheduling; virtual time is used only for the idle lifecycle test.
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await delay(20);
  }
  assert.fail('Observable lifecycle outcome did not arrive');
}
async function pinnedArchive(fetch, entry) {
  const url = new URL(entry.resolved);
  assert.equal(url.origin, 'https://registry.npmjs.org');
  assert.equal(url.pathname, `/pi-mcp-adapter/-/pi-mcp-adapter-${entry.version}.tgz`);
  assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'error' });
  assert.equal(response.status, 200, 'CI retrieves the exact lock-resolved upstream artifact');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    assert.ok(size <= 8 * 1024 * 1024, 'pinned archive download is bounded');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, entry.integrity);
  return bytes;
}
function retainedFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? retainedFiles(join(directory, entry.name)) : entry.isFile() ? [readFileSync(join(directory, entry.name), 'utf8')] : []);
}
async function fixture(t, { unavailable = false, oauth = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'pi-mcp-adapter-'));
  const agentDir = join(home, '.pi/agent'); mkdirSync(agentDir, { recursive: true });
  const originalFetch = globalThis.fetch;
  const environment = Object.fromEntries(['HOME', 'PI_CODING_AGENT_DIR', 'PI_MCP_ADAPTER_OAUTH_FILE_KEY',
    'PI_MCP_ADAPTER_DISABLE_AUTH_CACHE', 'BROWSER'].map(key => [key, process.env[key]]));
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  if (oauth) {
    // Native documented headless backend, not a keyring mock or user credential store.
    process.env.PI_MCP_ADAPTER_OAUTH_FILE_KEY = randomBytes(32).toString('base64');
    process.env.PI_MCP_ADAPTER_DISABLE_AUTH_CACHE = '1';
    // Exercise the real headless/manual callback path; never launch a desktop browser.
    process.env.BROWSER = '/bin/false';
  }
  let session, sessionSequence = 0, authorization, pendingCall, activeCall;
  let shutdown = async () => {};
  t.after(async () => {
    try {
      pendingCall?.release(); activeCall?.release();
      if (session) {
        try { await shutdown(); }
        finally { session.dispose(); }
      }
    } finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(environment)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
  const deps = join(repo, 'preseed/agents/pi/node_modules'), candidate = join(deps, 'pi-mcp-adapter');
  const installed = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8'));
  const selected = JSON.parse(readFileSync(join(repo, 'preseed/agents/pi/package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(repo, 'preseed/agents/pi/package-lock.json'), 'utf8'));
  // Intentional installed-artifact contract, independent of the behavioral checks.
  assert.equal(installed.version, selected.dependencies['pi-mcp-adapter']);
  assert.equal(installed.version, lock.packages['node_modules/pi-mcp-adapter'].version);
  const sdkRoot = join(deps, '@earendil-works/pi-coding-agent');
  assert.equal(JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8')).version, selected.dependencies['@earendil-works/pi-coding-agent']);
  // Compare every upstream archive file with the installed artifact: bundling below
  // is CI-only loading, never a source/vendor patch.
  const { execFileSync } = await import('node:child_process');
  const archive = join(home, 'upstream.tgz');
  writeFileSync(archive, await pinnedArchive(originalFetch, lock.packages['node_modules/pi-mcp-adapter']));
  const members = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', timeout: 5000 }).trim().split('\n');
  for (const member of members) assert.ok(member.startsWith('package/') && !member.split('/').includes('..'));
  const upstream = join(home, 'upstream'); mkdirSync(upstream);
  execFileSync('tar', ['-xzf', archive, '-C', upstream], { timeout: 5000 });
  for (const member of members.filter(name => !name.endsWith('/'))) {
    assert.deepEqual(readFileSync(join(candidate, member.slice('package/'.length))),
      readFileSync(join(upstream, member)), `unmodified upstream artifact: ${member}`);
  }
  symlinkSync(deps, join(home, 'node_modules'), 'dir');
  const { build } = await import('esbuild');
  await build({ entryPoints: { extension: join(candidate, installed.pi.extensions[0]),
    ...(oauth ? { oauth: join(candidate, 'oauth.ts') } : {}) }, outdir: home, outExtension: { '.js': '.mjs' },
    bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent' });
  const name = oauth ? `local-oauth-${randomBytes(6).toString('hex')}` : 'codeflare-portal-fixture';
  const server = oauth ? { url: 'https://local-oauth.example/mcp', auth: 'oauth', lifecycle: 'lazy', idleTimeout: 10,
    directTools: 'search', oauth: { redirectUri: 'https://synthetic-callback.example/callback' } }
    : { url: 'https://portal.example/mcp?codemode=search_and_execute',
      headers: { Authorization: 'Bearer codeflare-mcp-portal' }, auth: false, lifecycle: 'lazy', idleTimeout: 10,
      requestTimeoutMs: 360000, directTools: 'search' };
  const config = { settings: { requestTimeoutMs: 360000, idleTimeout: 10, autoAuth: false, deferWithMissingMetadata: true,
    ...(oauth ? { oauthCredentialStore: 'encrypted-file' } : {}) },
    mcpServers: { [name]: server,
      ...(unavailable ? { 'codeflare-portal-unavailable': { ...server, url: 'https://unavailable.example/mcp' } } : {}) } };
  const requests = [];
  const sessions = new Set(), grants = [];
  const metadata = { issuer: 'https://local-oauth.example', authorization_endpoint: 'https://local-oauth.example/authorize',
    token_endpoint: 'https://local-oauth.example/token', registration_endpoint: 'https://local-oauth.example/register',
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] };
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), u = new URL(request.url);
    // Only the explicitly unmanaged fixture may use Pi-owned native OAuth.
    if (oauth && u.hostname === 'local-oauth.example') {
      if (u.pathname.startsWith('/.well-known/oauth-protected-resource')) return Response.json({
        resource: server.url, authorization_servers: [metadata.issuer] });
      if (u.pathname.startsWith('/.well-known/')) return Response.json(metadata);
      if (u.pathname === '/register') return Response.json({ ...await request.json(), client_id: 'synthetic-client' }, { status: 201 });
      if (u.pathname === '/token') {
        const body = new URLSearchParams(await request.text());
        const grant = body.get('grant_type');
        if (grant === 'authorization_code') {
          assert.ok(authorization);
          assert.equal(body.get('code'), 'synthetic-one-use-code');
          assert.equal(body.get('redirect_uri'), authorization.searchParams.get('redirect_uri'));
          assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'),
            authorization.searchParams.get('code_challenge'), 'real PKCE verifier matches the authorization challenge');
        } else {
          assert.equal(grant, 'refresh_token');
          assert.equal(body.get('refresh_token'), 'synthetic-local-refresh');
        }
        grants.push(grant);
        return Response.json({ access_token: grant === 'refresh_token' ? 'synthetic-refreshed-access' : 'synthetic-local-access',
          refresh_token: 'synthetic-local-refresh', token_type: 'Bearer', expires_in: 3600 });
      }
      assert.equal(u.pathname, '/mcp');
      if (!['Bearer synthetic-local-access', 'Bearer synthetic-refreshed-access'].includes(request.headers.get('Authorization'))) {
        return new Response(null, { status: 401, headers: {
          'WWW-Authenticate': 'Bearer resource_metadata="https://local-oauth.example/.well-known/oauth-protected-resource"' } });
      }
    } else {
      // No external network or OAuth endpoints, even on an unavailable managed portal.
      assert.ok(['portal.example', 'unavailable.example'].includes(u.hostname), 'external network forbidden');
      assert.equal(u.pathname, '/mcp', 'managed portal must never initiate Pi OAuth discovery');
      assert.equal(request.headers.get('Authorization'), 'Bearer codeflare-mcp-portal');
    }
    const observation = { host: u.hostname, method: request.method, session: request.headers.get('mcp-session-id') };
    requests.push(observation);
    if (u.hostname === 'unavailable.example') return new Response(null, { status: 401,
      headers: { 'WWW-Authenticate': 'Bearer resource_metadata="https://unavailable.example/.well-known/oauth-protected-resource"' } });
    if (!oauth) assert.equal(u.searchParams.get('codemode'), 'search_and_execute');
    if (request.method === 'GET') {
      // Model an open HTTP event stream, including transport abort propagation.
      let ended = false;
      const body = new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(': synthetic keepalive\n\n'));
        const abort = () => {
          observation.aborted = true;
          if (!ended) { ended = true; controller.close(); }
        };
        if (request.signal.aborted) abort();
        else request.signal.addEventListener('abort', abort, { once: true });
      }, cancel() { ended = true; observation.cancelled = true; } });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (request.method === 'DELETE') { sessions.delete(request.headers.get('mcp-session-id')); return new Response(null, { status: 200 }); }
    const message = await request.json();
    observation.rpc = message;
    if (message.id === undefined) return new Response(null, { status: 202 });
    let result, headers;
    if (message.method === 'initialize') {
      const id = `fixture-session-${++sessionSequence}`; sessions.add(id);
      headers = { 'mcp-session-id': id };
      result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: 'synthetic-portal', version: '1' } };
    } else {
      assert.ok(sessions.has(request.headers.get('mcp-session-id')), 'calls retain their originating HTTP session');
      if (message.method === 'tools/list') result = { tools: ['search', 'execute'].map(operation => ({
        name: `portal_codemode_${operation}`, description: `${operation} live synthetic catalogue`,
        inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
      })) };
      else if (message.method === 'tools/call') {
        if (pendingCall) {
          activeCall = pendingCall; pendingCall = undefined;
          activeCall.arrived(); await activeCall.wait; activeCall = undefined;
        }
        result = { content: [{ type: 'text', text: `same-portal synthetic result: ${message.params.name}` }] };
      }
      else if (['ping', 'resources/list', 'prompts/list'].includes(message.method)) {
        result = message.method === 'resources/list' ? { resources: [] } : message.method === 'prompts/list' ? { prompts: [] } : {};
      } else throw Error(`Unexpected MCP operation: ${message.method}`);
    }
    return Response.json({ jsonrpc: '2.0', id: message.id, result }, { headers });
  };
  const sdk = await import(pathToFileURL(join(sdkRoot, 'dist/index.js')).href);
  const { createMcpAdapter } = await import(pathToFileURL(join(home, 'extension.mjs')).href);
  const settingsManager = sdk.SettingsManager.inMemory({ packages: [], extensions: ['-builtin:mcp'] });
  const loader = new sdk.DefaultResourceLoader({ cwd: home, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [createMcpAdapter({ config })] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(home, 'auth.json'), modelsPath: join(home, 'models.json') });
  ({ session } = await sdk.createAgentSession({ cwd: home, agentDir, resourceLoader: loader,
    settingsManager, modelRuntime, sessionManager: sdk.SessionManager.inMemory(home), noTools: true }));
  let shutdownPromise;
  shutdown = () => shutdownPromise ??= session.extensionRunner.emit({ type: 'session_shutdown' });
  const errors = [];
  await session.bindExtensions({ mode: 'print', onError: error => errors.push(error) });
  assert.deepEqual(errors, []);
  const oauthApi = oauth ? await import(pathToFileURL(join(home, 'oauth.mjs')).href) : undefined;
  const call = (args = {}) => {
    const tool = session.getToolDefinition('mcp');
    assert.ok(tool, 'real Pi exposes the adapter proxy');
    return tool.execute('qualification', args, undefined, undefined,
      session.extensionRunner.createToolContext('qualification', undefined));
  };
  return { home, name, requests, session, call, shutdown, grants, oauthApi, serverUrl: server.url,
    authorization(url) { authorization = new URL(url); return authorization; },
    holdNextCall() {
      let arrived, release;
      const started = new Promise(resolve => { arrived = resolve; });
      const wait = new Promise(resolve => { release = resolve; });
      pendingCall = { arrived, release, wait };
      return { started, release };
    },
    status: async () => (await call()).details.servers,
  };
}

test('REQ-AGENT-228: adapter placeholder proxy discovers and executes originating portal wrappers with explicit partial coverage', { timeout: 60000 }, async t => {
  const f = await fixture(t, { unavailable: true });
  const connected = await f.call({ connect: f.name });
  assert.equal(connected.details.error, undefined, JSON.stringify(connected));
  const discovered = await f.call({ search: 'portal_codemode', server: f.name });
  const matches = discovered.details.matches;
  assert.equal(matches.length, 2);
  for (const suffix of ['search', 'execute']) {
    const match = matches.find(row => row.tool.endsWith(`portal_codemode_${suffix}`));
    assert.ok(match);
    assert.ok(f.session.getActiveToolNames().includes(match.tool), 'search exposes the discovered callable tool in real Pi');
    const described = await f.call({ describe: match.tool, server: f.name });
    assert.match(JSON.stringify(described), /code/);
    const result = await f.call({ tool: match.tool, server: f.name, args: { code: 'async () => ({ ok: true })' } });
    assert.match(JSON.stringify(result), new RegExp(`same-portal synthetic result: portal_codemode_${suffix}`));
  }
  const unavailable = await f.call({ connect: 'codeflare-portal-unavailable' });
  assert.ok(unavailable.details.error, 'unavailable portal never reports ready');
  assert.match(JSON.stringify(await f.status()), /codeflare-portal-unavailable/);
  const auth = await f.call({ action: 'auth-start', server: f.name });
  assert.equal(auth.details.error, 'oauth_not_supported', 'managed portal authentication remains Settings-owned');
  assert.ok(f.requests.some(row => row.rpc?.method === 'tools/call'));
  assert.equal(existsSync(join(f.home, '.pi/agent/mcp-auth.json')), false,
    'managed authentication creates no Pi MCP OAuth grant file');
});

test('REQ-AGENT-228: native ten-minute idle cleanup disconnects and the next proxy call reconnects', { timeout: 60000 }, async t => {
  // Only Date and interval scheduling are controlled; request timers and async I/O stay real.
  const epoch = Date.now();
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: epoch });
  const f = await fixture(t);
  await f.call({ connect: f.name });
  const discovery = await f.call({ search: 'portal_codemode_execute', server: f.name });
  const tool = discovery.details.matches[0]?.tool;
  assert.ok(tool);
  assert.match(JSON.stringify(await f.call({ tool, server: f.name, args: { code: 'async () => 1' } })), /same-portal synthetic result/);
  const previousSession = f.requests.findLast(row => row.rpc?.method === 'tools/call').session;
  t.mock.timers.tick(11 * 60 * 1000);
  await until(async () => (await f.status()).some(row => row.name === f.name && row.status !== 'connected'));
  await until(() => f.requests.some(row => row.method === 'GET' && row.session === previousSession && (row.aborted || row.cancelled)));
  // Status is the public lifecycle outcome, not an assertion on a private manager call.
  assert.match(JSON.stringify(await f.call({ tool, server: f.name, args: { code: 'async () => 2' } })), /same-portal synthetic result/);
  const nextSession = f.requests.findLast(row => row.rpc?.method === 'tools/call').session;
  assert.notEqual(nextSession, previousSession, 'next call uses a fresh originating HTTP session');
});

test('REQ-AGENT-228: idle cleanup protects an active portal call and closes only after completion', { timeout: 60000 }, async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  const f = await fixture(t);
  await f.call({ connect: f.name });
  const found = await f.call({ search: 'portal_codemode_execute', server: f.name });
  const tool = found.details.matches[0]?.tool; assert.ok(tool);
  const held = f.holdNextCall();
  const result = f.call({ tool, server: f.name, args: { code: 'async () => 1' } });
  await held.started;
  t.mock.timers.tick(11 * 60 * 1000);
  assert.ok((await f.status()).some(row => row.name === f.name && row.status === 'connected'));
  held.release();
  assert.match(JSON.stringify(await result), /same-portal synthetic result/);
  t.mock.timers.tick(11 * 60 * 1000);
  await until(async () => (await f.status()).some(row => row.name === f.name && row.status !== 'connected'));
});

test('REQ-AGENT-228: unmanaged local OAuth retains real PKCE grant persistence, refresh and shutdown lifecycle', { timeout: 60000 }, async t => {
  const f = await fixture(t, { oauth: true });
  const storage = { credentialStore: 'encrypted-file' };
  const inspect = () => f.oauthApi.inspectMcpOAuthTokensForUrl(f.name, f.serverUrl, storage);
  assert.equal(inspect().status, 'absent');
  const started = await f.call({ action: 'auth-start', server: f.name });
  assert.equal(started.details.error, undefined);
  const authorization = f.authorization(started.details.authorizationUrl);
  assert.equal(authorization.origin, 'https://local-oauth.example');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  const callback = new URL(authorization.searchParams.get('redirect_uri'));
  callback.search = new URLSearchParams({ code: 'synthetic-one-use-code', state: 'invalid-state' }).toString();
  const rejected = await f.call({ action: 'auth-complete', server: f.name, args: { redirectUrl: callback.href } });
  assert.equal(rejected.details.error, 'auth_complete_failed');
  assert.equal(inspect().status, 'absent', 'invalid OAuth state cannot persist a grant');
  callback.searchParams.set('state', authorization.searchParams.get('state'));
  const completed = await f.call({ action: 'auth-complete', server: f.name, args: { redirectUrl: callback.href } });
  assert.equal(completed.details.authenticated, true, JSON.stringify(completed));
  assert.ok(f.grants.includes('authorization_code'), 'synthetic issuer accepted a real PKCE exchange');
  const persisted = inspect();
  assert.equal(persisted.status, 'present');
  assert.equal(persisted.tokens.refreshToken, 'synthetic-local-refresh', 'independent public storage facade reads the persisted grant');
  const encrypted = retainedFiles(join(f.home, '.pi/agent/mcp-oauth-encrypted'));
  assert.ok(encrypted.length > 0, 'native encrypted storage produces a persistent credential envelope');
  for (const secret of ['synthetic-local-access', 'synthetic-local-refresh', 'synthetic-one-use-code']) {
    assert.equal(encrypted.join('').includes(secret), false, 'credential envelope contains no plaintext grant');
    assert.equal(JSON.stringify(f.session.messages).includes(secret), false, 'Pi messages disclose no grant secrets');
  }
  // Public native API expires this synthetic grant; the real adapter/SDK must refresh it.
  await f.oauthApi.updateMcpOAuthTokensForUrl(f.name, f.serverUrl,
    { ...persisted.tokens, expiresAt: Math.floor(Date.now() / 1000) - 60 }, storage);
  const connected = await f.call({ connect: f.name });
  assert.equal(connected.details.error, undefined, JSON.stringify(connected));
  assert.ok(f.grants.includes('refresh_token'), 'issuer receives the native refresh grant');
  assert.equal(inspect().tokens.accessToken, 'synthetic-refreshed-access');
  const discovery = await f.call({ search: 'portal_codemode_execute', server: f.name });
  const tool = discovery.details.matches[0]?.tool;
  assert.ok(tool);
  assert.match(JSON.stringify(await f.call({ tool, server: f.name, args: { code: 'async () => ({ ok: true })' } })), /same-portal synthetic result/);
  await until(() => f.requests.some(row => row.method === 'GET' && !row.aborted && !row.cancelled));
  await f.shutdown();
  await until(() => f.requests.filter(row => row.method === 'GET').every(row => row.aborted || row.cancelled));
  assert.equal(inspect().tokens.refreshToken, 'synthetic-local-refresh', 'shutdown releases HTTP streams without deleting the unrelated persisted grant');
});
