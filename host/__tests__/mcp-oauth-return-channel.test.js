import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createHostedOAuthAdapter, mcpPortalOAuth } from '../../preseed/agents/pi/extensions/mcp-portal-oauth.ts';
import { channelFixture } from '../__fixtures__/mcp-oauth-channel.mjs';

test('REQ-AGENT-226: companion factory stays inert without parent configuration or a prepared MCP package', async () => {
  const original = process.env.CODEFLARE_MCP_HOSTED;
  delete process.env.CODEFLARE_MCP_HOSTED;
  try {
    const bus = new EventEmitter(), handlers = new Map(), visible = [];
    mcpPortalOAuth({ events: { on: (name, fn) => bus.on(name, fn) }, on: (name, fn) => handlers.set(name, fn) });
    for (const name of ['session_before_switch', 'session_before_fork', 'session_before_tree']) handlers.get(name)({});
    handlers.get('session_shutdown')({ reason: 'reload' });
    let result;
    bus.emit('codeflare:mcp-hosted-oauth', { serverName: 'codeflare-portal-fixture', config: { url: 'https://portal.example/mcp', auth: { type: 'oauth' } },
      ctx: { hasUI: true, mode: 'tui', ui: { notify: value => visible.push(value) } }, signal: new AbortController().signal,
      resolve(value) { result = value; } });
    await assert.rejects(result, /Hosted MCP authorization unavailable/);
    assert.deepEqual(visible, []);
    handlers.get('session_shutdown')({ reason: 'quit' });
  } finally { if (original === undefined) delete process.env.CODEFLARE_MCP_HOSTED; else process.env.CODEFLARE_MCP_HOSTED = original; }
});

const state = 'a'.repeat(64);
const config = { url: 'https://portal.example/mcp?codemode=search_and_execute', auth: { type: 'oauth' } };
async function pending(t, options) {
  const f = channelFixture(options); t.after(() => f.close());
  const adapter = createHostedOAuthAdapter(f.channel); t.after(() => adapter.close());
  const notifications = [];
  const controller = new AbortController();
  const run = await adapter.begin('codeflare-portal-fixture', config, { ui: { notify: value => notifications.push(value) } }, controller.signal);
  const result = run.callbackServer.waitForCallback(state); void result.catch(() => {});
  const url = new URL('https://portal.example/authorize');
  url.search = new URLSearchParams({ state, redirect_uri: run.redirectUrl, code_challenge_method: 'S256', code_challenge: 'synthetic-challenge' }).toString();
  await run.openBrowser(url.toString(), { authorizationServerMetadata: { issuer: 'https://portal.example', authorization_endpoint: 'https://portal.example/authorize' } });
  return { ...f, adapter, run, result, controller, notifications, binding: f.host.lookup(state) };
}

test('hosted return reaches only the original live pipe and is consumed once', async t => {
  const f = await pending(t);
  assert.equal(f.notifications.length, 1);
  assert.equal(f.binding.redirect, 'https://instance.example/auth/mcp/callback');
  for (const key of ['owner', 'session', 'generation', 'instance', 'process', 'flow', 'server', 'issuer', 'redirect', 'state', 'expires']) {
    assert.equal(f.host.deliver({ ...f.binding, [key]: key === 'generation' || key === 'expires' ? -1 : 'wrong', code: 'synthetic-code' }), false, key);
  }
  assert.equal(f.host.deliver({ ...f.binding, code: 'synthetic-code' }), true);
  assert.equal(await f.result, 'synthetic-code');
  assert.equal(f.host.deliver({ ...f.binding, code: 'synthetic-code' }), false);
  assert.equal(f.host.lookup(state), undefined);
});

for (const kind of ['abort', 'disconnect', 'generation', 'shutdown', 'expiry', 'peer-close']) {
  test(`hosted return cancellation: ${kind} cannot deliver or move the waiter`, async t => {
    const f = await pending(t);
    if (kind === 'abort') f.controller.abort();
    if (kind === 'disconnect') f.disconnect();
    if (kind === 'generation') f.host.configure({ owner: 'owner', session: 'abcdefgh', generation: 2, instance: 'https://instance.example' });
    if (kind === 'shutdown') f.host.close();
    if (kind === 'peer-close') f.channel.destroy();
    if (kind === 'expiry') {
      const real = Date.now; Date.now = () => real() + 300001;
      try { assert.equal(f.host.deliver({ ...f.binding, code: 'never-delivered' }), false); } finally { Date.now = real; }
      f.adapter.cancel();
    }
    await assert.rejects(f.result, /unavailable/);
    assert.equal(f.host.deliver({ ...f.binding, code: 'never-delivered' }), false);
  });
}

test('disconnect after return also cancels the original provider exchange signal', async t => {
  const f = await pending(t);
  assert.equal(f.host.deliver({ ...f.binding, code: 'synthetic-code' }), true);
  assert.equal(await f.result, 'synthetic-code');
  assert.equal(f.run.signal.aborted, false);
  f.disconnect();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.run.signal.aborted, true);
});

test('a launch capability cannot claim a second live recipient', async t => {
  const f = channelFixture(); t.after(() => f.close());
  const rejected = new PassThrough(); let response = '';
  rejected.on('data', chunk => { response += chunk; });
  f.host.attach({ method: 'GET', headers: { upgrade: 'codeflare-mcp-oauth', authorization: `Bearer ${f.launch.capability}` } }, rejected, Buffer.alloc(0));
  assert.match(response, /401 Unauthorized/);
  assert.equal(f.host.lookup(state), undefined);
});

test('session replacement while discovery is pending cannot register a later state', async t => {
  const f = channelFixture(); t.after(() => f.close());
  const adapter = createHostedOAuthAdapter(f.channel); t.after(() => adapter.close());
  const run = await adapter.begin('codeflare-portal-fixture', config, { ui: { notify() {} } }, new AbortController().signal);
  adapter.cancel();
  assert.throws(() => run.callbackServer.waitForCallback(state), /unavailable/);
  assert.equal(f.host.lookup(state), undefined);
});

test('managed portal override is rejected before exposing authorization', async t => {
  const f = channelFixture(); t.after(() => f.close());
  const adapter = createHostedOAuthAdapter(f.channel); t.after(() => adapter.close());
  await assert.rejects(adapter.begin('codeflare-portal-fixture', { ...config, url: 'https://other.example/mcp' }, { ui: { notify() { throw Error('URL must not be exposed'); } } }, new AbortController().signal), /unavailable/);
  assert.equal(f.host.lookup(state), undefined);
});

test('OAuth errors cancel the original waiter without reflecting provider text', async t => {
  const f = await pending(t);
  assert.equal(f.host.deliver({ ...f.binding, cancelled: true }), true);
  await assert.rejects(f.result, /unavailable/);
  assert.equal(f.host.lookup(state), undefined);
});
