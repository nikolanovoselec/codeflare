// Managed CI/image only. The real locked, unmodified extension and SDK are mandatory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
function files(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(path, e.name)) : [readFileSync(join(path, e.name), 'utf8')]);
}
async function fixture(t, { oauth = false, unavailable = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'pi-mcp-stock-'));
  const agent = join(home, '.pi/agent'); mkdirSync(agent, { recursive: true });
  const deps = join(repo, 'preseed/agents/pi/node_modules'), candidate = join(deps, 'pi-mcp-extension');
  const installed = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8'));
  const selected = JSON.parse(readFileSync(join(repo, 'preseed/agents/pi/package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(repo, 'preseed/agents/pi/package-lock.json'), 'utf8'));
  // This version pin is an intentional artifact contract; behavioral outcomes follow below.
  assert.equal(installed.version, selected.dependencies['pi-mcp-extension']);
  assert.equal(installed.version, lock.packages['node_modules/pi-mcp-extension'].version);
  symlinkSync(deps, join(home, 'node_modules'), 'dir');
  const { build } = await import('esbuild');
  await build({ entryPoints: [join(candidate, installed.pi.extensions[0])], outfile: join(home, 'extension.mjs'),
    bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent' });
  const configPath = join(agent, 'mcp.json');
  const name = oauth ? 'local-oauth' : 'codeflare-portal-fixture';
  const server = oauth ? { url: 'https://portal.example/mcp', auth: { type: 'oauth' }, lifecycle: 'lazy' }
    : { url: 'https://portal.example/mcp?codemode=search_and_execute', headers: { Authorization: 'Bearer codeflare-mcp-portal' }, lifecycle: 'eager' };
  const config = { settings: { maxRetries: 0 }, mcpServers: { [name]: server,
    ...(unavailable ? { 'codeflare-portal-unavailable': { ...server, url: 'https://unavailable.example/mcp' } } : {}) } };
  writeFileSync(configPath, JSON.stringify(config));
  const originalFetch = globalThis.fetch;
  let shutdown = async () => {}, authorization, refreshes = false, expired = false;
  const observed = { initialized: false, called: false, resource: false };
  const metadata = { issuer: 'https://portal.example', authorization_endpoint: 'https://portal.example/authorize',
    token_endpoint: 'https://portal.example/token', registration_endpoint: 'https://portal.example/register',
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] };
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), u = new URL(request.url);
    if (u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname)) return originalFetch(input, init);
    if (u.hostname === 'unavailable.example') return Response.json({ error: 'Reconnect in Settings' }, { status: 401 });
    if (u.origin !== 'https://portal.example') throw Error('External network forbidden in qualification');
    if (u.pathname.startsWith('/.well-known/oauth-protected-resource')) return Response.json({ resource: 'https://portal.example/mcp', authorization_servers: [metadata.issuer] });
    if (u.pathname.startsWith('/.well-known/')) return Response.json(metadata);
    if (u.pathname === '/register') return Response.json({ ...await request.json(), client_id: 'synthetic-client' }, { status: 201 });
    if (u.pathname === '/token') {
      const body = new URLSearchParams(await request.text());
      if (body.get('grant_type') === 'refresh_token') { refreshes = true; expired = false; }
      else {
        assert.ok(authorization);
        assert.equal(body.get('code'), 'synthetic-one-use-code');
        assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), authorization.searchParams.get('code_challenge'));
        assert.equal(body.get('redirect_uri'), authorization.searchParams.get('redirect_uri'));
      }
      return Response.json({ access_token: 'synthetic-local-access', refresh_token: 'synthetic-local-refresh', token_type: 'Bearer', expires_in: 3600 });
    }
    if (u.pathname !== '/mcp') throw Error('Unexpected synthetic endpoint');
    const expected = oauth ? 'Bearer synthetic-local-access' : 'Bearer codeflare-mcp-portal';
    if (expired || request.headers.get('Authorization') !== expected) return new Response(null, { status: 401,
      headers: { 'WWW-Authenticate': 'Bearer resource_metadata="https://portal.example/.well-known/oauth-protected-resource"' } });
    if (request.method === 'GET') return new Response(null, { status: 405 });
    if (request.method === 'DELETE') return new Response(null, { status: 200 });
    const message = await request.json();
    if (message.id === undefined) return new Response(null, { status: 202 });
    let result;
    if (message.method === 'initialize') { observed.initialized = true; result = { protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'synthetic-portal', version: '1' } }; }
    else if (message.method === 'tools/list') result = { tools: [
      { name: 'portal_codemode_search', description: 'Search live synthetic catalogue', inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
      { name: 'portal_codemode_execute', description: 'Execute through originating portal', inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
    ] };
    else if (message.method === 'tools/call') { observed.called = true; result = { content: [{ type: 'text', text: 'same-portal synthetic result' }] }; }
    else if (message.method === 'resources/list') result = { resources: [{ uri: 'fixture://status', name: 'status' }] };
    else if (message.method === 'resources/read') { observed.resource = true; result = { contents: [{ uri: 'fixture://status', text: 'ready' }] }; }
    else if (message.method === 'ping') result = {};
    else throw Error('Unexpected MCP operation');
    return Response.json({ jsonrpc: '2.0', id: message.id, result });
  };
  t.after(async () => { try { await shutdown(); } finally { globalThis.fetch = originalFetch; rmSync(home, { recursive: true, force: true }); } });
  const handlers = new Map(), tools = new Map(), commands = new Map(), notices = [];
  let active = [];
  const pi = { on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerCommand(name, command) { commands.set(name, command); }, getMcpServers: () => [],
    registerTool(tool) { tools.set(tool.name, tool); active.push(tool.name); }, getAllTools: () => [...tools.values()],
    getActiveTools: () => active, setActiveTools: value => { active = value; } };
  const ctx = { cwd: home, mode: 'tui', hasUI: true, isProjectTrusted: () => false,
    ui: { notify: value => notices.push(value), setStatus() {}, setWidget() {}, select: async () => 'Later' } };
  const emit = async name => { for (const handler of handlers.get(name) ?? []) await handler({}, ctx); };
  const { default: register } = await import(pathToFileURL(join(home, 'extension.mjs')).href);
  await register(pi, { bootstrapCwd: home, globalConfigPath: configPath, authStorageDir: join(home, 'auth'),
    browserOpen: async url => {
      if (!oauth) throw Error('Managed placeholders must never initiate Pi OAuth');
      authorization = new URL(url);
      const callback = new URL(authorization.searchParams.get('redirect_uri'));
      callback.search = new URLSearchParams({ state: authorization.searchParams.get('state'), code: 'synthetic-one-use-code' }).toString();
      assert.equal((await originalFetch(callback)).status, 200);
    } });
  shutdown = () => emit('session_shutdown'); await emit('session_start');
  return { home, tools, notices, observed, emit, name,
    command: command => commands.get(command).handler(name, ctx),
    call: (tool, args) => tools.get(tool).execute('fixture', args, undefined, undefined, ctx),
    tool: suffix => [...tools.keys()].find(name => name.endsWith(suffix)),
    expire() { expired = true; }, refreshed: () => refreshes, retained: () => files(home),
  };
}

test('REQ-AGENT-227: stock eager placeholder connections register live Code Mode wrappers with explicit partial coverage', async t => {
  const f = await fixture(t, { unavailable: true });
  assert.equal(f.observed.initialized, true);
  const search = f.tool('portal_codemode_search'), execute = f.tool('portal_codemode_execute');
  assert.ok(search); assert.ok(execute);
  const status = await f.call('mcp_status', {});
  assert.match(JSON.stringify(status), /unavailable/);
  assert.match(JSON.stringify(await f.call(search, { code: 'async () => await codemode.tools()' })), /same-portal synthetic result/);
  assert.match(JSON.stringify(await f.call(execute, { code: 'async () => ({ ok: true })' })), /same-portal synthetic result/);
  assert.equal(f.observed.called, true);
  assert.equal(existsSync(join(f.home, 'auth')), false, 'managed portal creates no Pi OAuth credential store');
  for (const secret of ['synthetic-local-access', 'synthetic-local-refresh', 'synthetic-one-use-code']) assert.equal(f.retained().join('').includes(secret), false);
});

test('REQ-AGENT-227: unmanaged local OAuth retains real PKCE grant persistence, refresh and shutdown lifecycle', async t => {
  const f = await fixture(t, { oauth: true });
  assert.equal(f.observed.initialized, false);
  await f.command('mcp:auth');
  assert.equal(f.observed.initialized, true);
  assert.ok(f.tool('portal_codemode_search'));
  assert.ok(files(join(f.home, 'auth')).join('').includes('synthetic-local-refresh'));
  for (const secret of ['synthetic-local-access', 'synthetic-local-refresh', 'synthetic-one-use-code']) assert.equal(JSON.stringify(f.notices).includes(secret), false);
  await f.command('mcp:stop'); f.expire();
  await f.call('mcp_connect', { name: f.name });
  assert.equal(f.refreshed(), true);
  assert.match(JSON.stringify(await f.call(f.tool('portal_codemode_execute'), { code: 'async () => ({ ok: true })' })), /same-portal synthetic result/);
  await f.command('mcp:stop');
  const stopped = await f.call('mcp_status', {});
  assert.match(JSON.stringify(stopped), /disconnected|stopped/);
});
