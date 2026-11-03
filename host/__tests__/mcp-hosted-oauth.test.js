// CI/image qualification only: real locked prepared extension + original SDK.
// No test is skipped when the selected candidate or its dependencies are absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { channelFixture } from '../__fixtures__/mcp-oauth-channel.mjs';
import { prepareHostedOAuth } from '../../scripts/patch-pi-mcp-hosted-oauth.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const dependencies = join(repo, 'preseed/agents/pi/node_modules');
const candidate = join(dependencies, 'pi-mcp-extension');
const selectedManifest = join(repo, 'preseed/agents/pi/package.json');
const selectedLock = join(repo, 'preseed/agents/pi/package-lock.json');
const companionPath = join(repo, 'preseed/agents/pi/extensions/mcp-portal-oauth.ts');
const prepareOptions = { selectedManifest, selectedLock, companionPath };
const portal = { name: 'fixture', url: 'https://portal.example/mcp?codemode=search_and_execute' };
const metadata = { issuer: 'https://portal.example', authorization_endpoint: 'https://portal.example/authorize',
  token_endpoint: 'https://portal.example/token', registration_endpoint: 'https://portal.example/register',
  response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] };

function syntheticProvider() {
  let authorization, used = false, rejectOldToken = false;
  let access = 'synthetic-access-1';
  const observations = { registrations: [], exchanges: [], initialized: [], tools: [], refreshes: [] };
  const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers });
  const challenge = () => new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Bearer resource_metadata="https://portal.example/.well-known/oauth-protected-resource"' } });
  const fetch = async (input, init) => {
    const request = new Request(input, init), u = new URL(request.url);
    if (u.origin !== 'https://portal.example') throw new Error('Synthetic qualification forbids external provider I/O');
    if (u.pathname.startsWith('/.well-known/oauth-protected-resource')) return json({ resource: 'https://portal.example/mcp', authorization_servers: [metadata.issuer], scopes_supported: ['mcp'] });
    if (u.pathname.startsWith('/.well-known/')) return json(metadata);
    if (u.pathname === '/register') {
      const body = await request.json(); observations.registrations.push(body.redirect_uris);
      return json({ ...body, client_id: 'synthetic-public-client', token_endpoint_auth_method: 'none' }, 201);
    }
    if (u.pathname === '/token') {
      const body = new URLSearchParams(await request.text());
      if (body.get('grant_type') === 'refresh_token') {
        assert.equal(body.get('refresh_token'), 'synthetic-refresh');
        observations.refreshes.push('refreshed'); access = 'synthetic-access-2'; rejectOldToken = false;
      } else {
        assert.ok(authorization, 'owner saw the authorization URL before exchange');
        assert.equal(used, false, 'authorization code is one-use'); used = true;
        assert.equal(body.get('code'), 'synthetic-one-use-code');
        assert.equal(body.get('redirect_uri'), authorization.searchParams.get('redirect_uri'));
        const challenge = createHash('sha256').update(body.get('code_verifier')).digest('base64url');
        assert.equal(challenge, authorization.searchParams.get('code_challenge'));
        observations.exchanges.push({ redirect: body.get('redirect_uri'), pkce: true });
      }
      return json({ access_token: access, refresh_token: 'synthetic-refresh', token_type: 'Bearer', expires_in: 3600, scope: 'mcp' });
    }
    if (u.pathname === '/mcp') {
      if (request.headers.get('Authorization') !== `Bearer ${access}` || rejectOldToken) return challenge();
      if (request.method === 'GET') return new Response(null, { status: 405 });
      if (request.method === 'DELETE') return new Response(null, { status: 200 });
      const message = await request.json();
      if (message.id === undefined) return new Response(null, { status: 202 });
      let result;
      if (message.method === 'initialize') {
        observations.initialized.push('authenticated');
        result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'synthetic-portal', version: '1' } };
      } else if (message.method === 'tools/list') result = { tools: [{ name: 'fixture_echo', description: 'Synthetic portal tool', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }] };
      else if (message.method === 'tools/call') { observations.tools.push(message.params.arguments); result = { content: [{ type: 'text', text: `Synthetic portal: ${message.params.arguments.value}` }] }; }
      else if (message.method === 'ping') result = {};
      else throw new Error('Unexpected synthetic MCP operation');
      return json({ jsonrpc: '2.0', id: message.id, result });
    }
    throw new Error('Unexpected synthetic OAuth path');
  };
  return { fetch, observations, authorize(url) { authorization = new URL(url); return authorization; }, rejectStoredToken() { rejectOldToken = true; } };
}

async function fixture(t, { companion = true, local = false, override = false } = {}) {
  // Exact package identity and prepared result are artifact contracts, not
  // substitutes for the provider/PKCE/MCP outcomes asserted below.
  const installed = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8'));
  assert.equal(installed.version, JSON.parse(readFileSync(selectedManifest, 'utf8')).dependencies['pi-mcp-extension']);
  assert.ok(existsSync(join(candidate, 'src/codeflare-hosted-oauth.ts')), 'candidate must be prepared before loading');
  const home = mkdtempSync(join(tmpdir(), 'hosted-mcp-qualification-'));
  const agent = join(home, '.pi/agent');
  const { mkdirSync } = await import('node:fs'); mkdirSync(agent, { recursive: true });
  symlinkSync(dependencies, join(home, 'node_modules'), 'dir');
  const savedEnv = Object.fromEntries(['HOME', 'PI_CODING_AGENT_DIR', 'CODEFLARE_MCP_HOSTED', 'CODEFLARE_MCP_PORTALS_JSON', 'PI_MCP_DEBUG'].map(k => [k, process.env[k]]));
  Object.assign(process.env, { HOME: home, PI_CODING_AGENT_DIR: agent, CODEFLARE_MCP_HOSTED: '1', CODEFLARE_MCP_PORTALS_JSON: JSON.stringify([portal]), PI_MCP_DEBUG: '1' });
  const provider = syntheticProvider(), originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    if (local && u.protocol === 'http:' && u.hostname === '127.0.0.1') return originalFetch(input, init);
    return provider.fetch(input, init);
  };
  const channel = channelFixture();
  let shutdown = async () => {};
  t.after(async () => {
    try { await shutdown(); } finally {
      channel.close(); globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      rmSync(home, { recursive: true, force: true });
    }
  });
  const { build } = await import('esbuild');
  await build({ entryPoints: { extension: join(candidate, installed.pi.extensions[0]), companion: companionPath }, outdir: home,
    bundle: true, packages: 'external', platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' }, logLevel: 'silent' });
  const name = local ? 'local-fixture' : 'codeflare-portal-fixture';
  const configPath = join(agent, 'mcp.json');
  writeFileSync(configPath, JSON.stringify({ mcpServers: { [name]: { url: override ? 'https://wrong.example/mcp' : portal.url, auth: { type: 'oauth' }, lifecycle: 'lazy' } } }));
  const handlers = new Map(), tools = new Map(), commands = new Map(), ui = [], modelArtifacts = [];
  const bus = new EventEmitter();
  let active = ['read', 'bash', 'edit', 'write'];
  let onAuthorization = () => {};
  const pi = {
    events: { on: (name, handler) => bus.on(name, handler), emit: (name, value) => bus.emit(name, value) },
    on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerCommand(name, spec) { commands.set(name, spec); }, getMcpServers: () => [],
    registerTool(tool) { tools.set(tool.name, tool); if (!active.includes(tool.name)) active.push(tool.name); },
    getAllTools: () => [...tools.values()], getActiveTools: () => [...active], setActiveTools: value => { active = [...value]; },
    sendMessage(value) { modelArtifacts.push(value); }, sendUserMessage(value) { modelArtifacts.push(value); },
  };
  const ctx = { cwd: home, mode: 'tui', hasUI: true, isProjectTrusted: () => false,
    ui: { notify(value) { ui.push(value); const url = value.match(/https:\/\/portal\.example\/authorize\?[^\s]+/); if (url) onAuthorization(url[0]); }, setStatus() {}, setWidget() {},
      select(_title, _options, { signal } = {}) { return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(Error('cancelled')), { once: true })); } } };
  const emit = async event => { for (const handler of handlers.get(event) ?? []) await handler({}, ctx); };
  const { default: initialize } = await import(pathToFileURL(join(home, 'extension.mjs')).href);
  await initialize(pi, { bootstrapCwd: home, globalConfigPath: configPath, authStorageDir: join(home, 'auth'),
    browserOpen: async url => {
      if (!local) throw Error('Hosted authorization must not call an OS browser opener');
      const authorization = provider.authorize(url);
      const callback = new URL(authorization.searchParams.get('redirect_uri'));
      callback.search = new URLSearchParams({ state: authorization.searchParams.get('state'), code: 'synthetic-one-use-code' }).toString();
      assert.equal((await originalFetch(callback)).status, 200);
    } });
  if (companion) {
    const { mcpPortalOAuth } = await import(pathToFileURL(join(home, 'companion.mjs')).href);
    mcpPortalOAuth(pi, channel.channel); // after upstream init: no load-order dependency
  }
  shutdown = () => emit('session_shutdown');
  await emit('session_start');
  const call = (name, args = {}, context = ctx) => tools.get(name).execute('synthetic-owner-tool', args, undefined, undefined, context);
  return { provider, ui, ctx, modelArtifacts, channel, home, emit, shutdown,
    tool() { return [...tools.keys()].find(k => k.includes('fixture_echo')); }, call,
    onAuthorization(handler) { onAuthorization = handler; },
    command(command = 'mcp:auth', args = name, context = ctx) { return commands.get(command).handler(args, context); },
    name,
  };
}

function complete(f, url) {
  const authorization = f.provider.authorize(url), state = authorization.searchParams.get('state');
  const binding = f.channel.host.lookup(state);
  assert.ok(binding, 'original state registered before URL exposure');
  assert.equal(binding.redirect, authorization.searchParams.get('redirect_uri'));
  assert.equal(f.channel.host.deliver({ ...binding, code: 'synthetic-one-use-code' }), true);
  assert.equal(f.channel.host.deliver({ ...binding, code: 'synthetic-one-use-code' }), false);
}

test('REQ-AGENT-226 AC1: only explicit owner initiation exposes hosted authorization', async t => {
  const f = await fixture(t);
  assert.equal(f.tool(), undefined, 'lazy server has no direct tool before connect');
  await assert.rejects(f.call('mcp_connect', { name: f.name }), /mcp:auth/);
  assert.equal(f.ui.some(v => v.includes('/authorize?')), false);
  assert.deepEqual(f.provider.observations.exchanges, []);
  await f.command('mcp:auth', f.name, { ...f.ctx, mode: 'rpc', hasUI: true });
  assert.equal(f.ui.some(v => v.includes('/authorize?')), false);
  await f.command('mcp:auth', f.name, { ...f.ctx, mode: 'print', hasUI: false });
  assert.equal(f.ui.some(v => v.includes('/authorize?')), false);
});

test('REQ-AGENT-226 AC2: the real prepared provider completes hosted OAuth and MCP initialization', async t => {
  const f = await fixture(t);
  f.onAuthorization(url => complete(f, url));
  await f.command();
  assert.deepEqual(f.provider.observations.registrations, [['https://instance.example/auth/mcp/callback']]);
  assert.deepEqual(f.provider.observations.exchanges, [{ redirect: 'https://instance.example/auth/mcp/callback', pkce: true }]);
  assert.ok(f.provider.observations.initialized.includes('authenticated'));
  assert.ok(f.tool(), JSON.stringify(f.ui));
  const result = await f.call(f.tool(), { value: 'owner-authorized synthetic call' });
  assert.match(JSON.stringify(result.content), /Synthetic portal: owner-authorized synthetic call/);
  const retained = JSON.stringify({ result, modelArtifacts: f.modelArtifacts, logs: artifacts(join(f.home, '.pi/agent/logs')) });
  for (const secret of ['synthetic-one-use-code', 'synthetic-access-1', 'synthetic-refresh']) assert.equal(retained.includes(secret), false);
  assert.ok(artifacts(join(f.home, 'auth')).some(text => text.includes('synthetic-refresh')), 'original provider persisted its own grant');
});

function artifacts(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? artifacts(join(root, entry.name)) : [readFileSync(join(root, entry.name), 'utf8')]);
}

test('REQ-AGENT-226 AC5: local OAuth refresh lazy tools and shutdown remain unchanged', async t => {
  const f = await fixture(t);
  f.onAuthorization(url => complete(f, url));
  await f.command();
  await f.command('mcp:stop');
  f.provider.rejectStoredToken();
  // Reconnect uses the real provider's persisted refresh grant, not another UI authorization.
  f.onAuthorization(() => { throw Error('A valid refresh grant must not open authorization'); });
  await f.command('mcp:start');
  assert.deepEqual(f.provider.observations.refreshes, ['refreshed']);
  const result = await f.call(f.tool(), { value: 'after-refresh' });
  assert.match(JSON.stringify(result.content), /after-refresh/);
  await f.shutdown();
  assert.equal(f.channel.host.lookup('a'.repeat(64)), undefined);
});

test('REQ-AGENT-226 AC5: unmanaged local OAuth retains the original loopback callback', async t => {
  const f = await fixture(t, { local: true });
  await f.command();
  assert.ok(f.provider.observations.exchanges[0]?.redirect.startsWith('http://127.0.0.1:'));
  const result = await f.call(f.tool(), { value: 'local' });
  assert.match(JSON.stringify(result.content), /Synthetic portal: local/);
});

test('hosted managed entry overrides and missing companions fail closed', async t => {
  await t.test('override', async t => {
    const f = await fixture(t, { override: true }); await f.command();
    assert.deepEqual(f.provider.observations.initialized, []); assert.deepEqual(f.provider.observations.registrations, []);
    assert.equal(f.ui.some(v => v.includes('/authorize?')), false);
  });
  await t.test('missing companion', async t => {
    const f = await fixture(t, { companion: false }); await f.command();
    assert.deepEqual(f.provider.observations.exchanges, []); assert.equal(f.ui.some(v => v.includes('/authorize?')), false);
  });
});

test('REQ-AGENT-226 AC6: preparation rejects drift without partial runnable output', t => {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-guard-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const copy = join(directory, 'candidate'); cpSync(candidate, copy, { recursive: true });
  assert.equal(prepareHostedOAuth(copy, prepareOptions).changed, false, 'complete prepared profile is idempotent');
  const before = readFileSync(join(copy, 'src/index.ts'), 'utf8');
  writeFileSync(join(copy, 'src/authorize-flow.ts'), 'unreviewed-sensitive-source-marker');
  assert.throws(() => prepareHostedOAuth(copy, prepareOptions), { message: 'Hosted MCP preparation rejected incompatible inputs' });
  assert.equal(readFileSync(join(copy, 'src/index.ts'), 'utf8'), before);
  assert.throws(() => prepareHostedOAuth(copy, { ...prepareOptions, companionPath: join(directory, 'absent') }), { message: 'Hosted MCP preparation rejected incompatible inputs' });
});

test('REQ-AGENT-226 AC7: candidate qualification uses the actual prepared dependency family', () => {
  const manifest = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(selectedLock, 'utf8'));
  assert.equal(manifest.version, lock.packages['node_modules/pi-mcp-extension'].version);
  assert.deepEqual(prepareHostedOAuth(candidate, prepareOptions), { prepared: true, changed: false });
});
