import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createChatProxy } from '../dist/chat-proxy.js';

// New first-party HTTP composition only; SDK/auth-flow and renderer internals
// are not exercised here. Exact operation bodies are intentional wire contracts.
const cfid = 'abcdef0123456789';
const initial = { sessionId: 'primary-a', generation: 7 };
const prefix = `/api/chat/${cfid}/api`;
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
async function jsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function request(port, path, { method = 'GET', body, generation = '7', scopePrefix = prefix } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: `${scopePrefix}${path}?generation=7`, method,
      headers: { 'content-type': 'application/json', 'x-codeflare-chat-generation': generation } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

describe('REQ-AGENT-224: bounded provider/history/display HTTP composition', { timeout: 15000 }, () => {
  let host, upstream, chat, port, live, credential, flow, prefs, forgedAdoption;
  beforeEach(async () => {
    live = initial;
    credential = false;
    flow = undefined;
    prefs = { reasoning: false };
    forgedAdoption = false;
    const scope = { cfid, ownerId: 'owner-a', generation: 7, primary: initial };
    const authorized = supplied => assert.deepEqual(supplied, scope);
    const auth = {
      async providers(supplied) { authorized(supplied); return { personalAuthAllowed: true,
        providers: [{ id: 'example', name: 'Example', authTypes: ['oauth'] }] }; },
      async status(supplied) { authorized(supplied); return { providers: [{ providerId: 'example', configured: credential }] }; },
      async start(supplied, body) {
        authorized(supplied);
        assert.deepEqual(body, { providerId: 'example', type: 'oauth' });
        flow = { flowId: 'flow-1', provider: 'example', status: 'pending', stepId: 'step-1',
          pending: { kind: 'manual_code', message: 'Paste code' } };
        return flow;
      },
      async flow(supplied, id) { authorized(supplied); assert.equal(id, 'flow-1'); return flow; },
      async input(supplied, id, body) {
        authorized(supplied);
        assert.equal(id, 'flow-1');
        assert.deepEqual(body, { stepId: 'step-1', value: 'test-code' });
        credential = true;
        flow = { flowId: id, provider: 'example', status: 'complete' };
      },
      async cancel(supplied, id) {
        authorized(supplied);
        assert.equal(id, 'flow-1');
        flow = { flowId: id, provider: 'example', status: 'expired', error: 'auth_cancelled' };
      },
      async logout(supplied, body) { authorized(supplied); assert.deepEqual(body, { providerId: 'example' }); credential = false; },
      close() {},
    };
    upstream = http.createServer(async (req, res) => {
      assert.equal(req.headers['x-pi-local-token'], 'fixture-token');
      assert.equal(req.url, '/api/preferences/display');
      if (req.method === 'PATCH') prefs = { ...prefs, ...await jsonBody(req) };
      res.writeHead(200, { 'content-type': 'application/json' });
      // Pinned native REST contract is {displayPrefs}; the Host owns the
      // public success/data envelope instead of leaking a generic proxy.
      res.end(JSON.stringify({ displayPrefs: prefs }));
    });
    const upstreamPort = await listen(upstream);
    const adopt = async (bound, target) => {
      assert.deepEqual(bound, initial);
      if (forgedAdoption) return { sessionId: 'unconfirmed-primary', generation: 7 };
      live = { sessionId: target, generation: 7 };
      return live;
    };
    chat = createChatProxy({ cfid, generation: 7, primary: () => live,
      ensurePrimary: async () => live, recordInput() {},
      upstream: { port: upstreamPort, token: () => 'fixture-token' },
      providerAuth: { forPrimary(bound) { assert.deepEqual(bound, initial); return { scope, service: auth }; }, close() {} },
      conversations: {
        async list(bound) { assert.deepEqual(bound, initial); return [{ id: 'older', name: 'Earlier work', messageCount: 3 }]; },
        async new(bound) { return adopt(bound, 'new-conversation'); },
        async resume(bound, id) { assert.equal(id, 'older'); return adopt(bound, id); },
        async fork(bound, entryId) { assert.equal(entryId, 'message-1'); return adopt(bound, 'forked-conversation'); },
      },
    });
    host = http.createServer((req, res) => chat.handleHttp(req, res));
    port = await listen(host);
  });
  afterEach(async () => {
    chat.close();
    await Promise.all([new Promise(resolve => host.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  });

  it('advertises complete controls without provider, transcript or runtime mutation', async () => {
    const result = await request(port, '/capabilities');
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { success: true, data: { controls: true } });
    assert.equal(credential, false);
    assert.equal(flow, undefined);
    assert.deepEqual(live, initial);
  });
  it('routes provider discovery/status and step-bound login to the actual primary credential authority', async () => {
    const providers = await request(port, '/provider-auth/providers');
    assert.equal(providers.status, 200);
    assert.equal(providers.data.data.providers[0].id, 'example');
    assert.equal((await request(port, '/provider-auth/status')).data.data.providers[0].configured, false);
    const started = await request(port, '/provider-auth/start', { method: 'POST', body: { providerId: 'example', type: 'oauth' } });
    assert.equal(started.status, 200);
    assert.equal(started.data.data.flowId, 'flow-1');
    assert.equal((await request(port, '/provider-auth/flow/flow-1')).data.data.stepId, 'step-1');
    assert.equal((await request(port, '/provider-auth/flow/flow-1/input', {
      method: 'POST', body: { stepId: 'step-1', value: 'test-code' },
    })).status, 200);
    assert.equal((await request(port, '/provider-auth/status')).data.data.providers[0].configured, true);
    assert.equal((await request(port, '/provider-auth/logout', { method: 'POST', body: { providerId: 'example' } })).status, 200);
    assert.equal((await request(port, '/provider-auth/status')).data.data.providers[0].configured, false);
  });
  it('cancel uses its scoped DELETE road and never becomes credential logout', async () => {
    await request(port, '/provider-auth/start', { method: 'POST', body: { providerId: 'example', type: 'oauth' } });
    credential = true;
    assert.equal((await request(port, '/provider-auth/flow/flow-1', { method: 'DELETE' })).status, 200);
    assert.equal((await request(port, '/provider-auth/flow/flow-1')).data.data.error, 'auth_cancelled');
    assert.equal((await request(port, '/provider-auth/status')).data.data.providers[0].configured, true);
  });
  it('returns the workspace conversation catalog from its authorized adapter', async () => {
    const result = await request(port, '/conversations');
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { success: true, data: [{ id: 'older', name: 'Earlier work', messageCount: 3 }] });
  });
  for (const [action, extra, expected] of [
    ['new', {}, 'new-conversation'], ['resume', { conversationId: 'older' }, 'older'],
    ['fork', { entryId: 'message-1' }, 'forked-conversation'],
  ]) {
    it(`native ${action} returns the confirmed adopted binding, not a competing conversation claim`, async () => {
      const result = await request(port, `/conversations/${action}`, {
        method: 'POST', body: { sessionId: initial.sessionId, ...extra },
      });
      assert.equal(result.status, 200);
      assert.deepEqual(result.data, { sessionId: expected, generation: 7 });
      assert.equal(live.sessionId, expected);
    });
  }
  it('rejects a foreign conversation carrier before performing its transition', async () => {
    const result = await request(port, '/conversations/new', { method: 'POST', body: { sessionId: 'foreign-primary' } });
    assert.equal(result.status, 409);
    assert.deepEqual(live, initial);
  });
  it('rejects an unconfirmed transition result instead of granting a different browser target', async () => {
    forgedAdoption = true;
    const result = await request(port, '/conversations/new', { method: 'POST', body: { sessionId: initial.sessionId } });
    assert.equal(result.status, 409);
    assert.deepEqual(live, initial);
  });
  it('reads and saves display defaults through the fixed private preference road', async () => {
    assert.deepEqual((await request(port, '/preferences/display')).data.data, { reasoning: false });
    const result = await request(port, '/preferences/display', { method: 'PATCH', body: { reasoning: true } });
    assert.equal(result.status, 200);
    assert.deepEqual((await request(port, '/preferences/display')).data.data, { reasoning: true });
  });
  it('rejects another allocation path before starting provider authentication in this container', async () => {
    const result = await request(port, '/provider-auth/start', { method: 'POST',
      scopePrefix: '/api/chat/1111111111111111/api', body: { providerId: 'example', type: 'oauth' } });
    assert.equal(result.status, 404);
    assert.equal(flow, undefined);
    assert.equal(credential, false);
  });
  it('new protected HTTP controls reject stale generations before changing native state', async () => {
    for (const [path, method, body] of [
      ['/provider-auth/start', 'POST', { providerId: 'example', type: 'oauth' }],
      ['/conversations/new', 'POST', { sessionId: initial.sessionId }],
      ['/preferences/display', 'PATCH', { reasoning: true }],
    ]) {
      assert.equal((await request(port, path, { method, body, generation: '6' })).status, 409);
    }
    assert.equal(credential, false);
    assert.equal(flow, undefined);
    assert.deepEqual(live, initial);
    assert.deepEqual(prefs, { reasoning: false });
  });
});
