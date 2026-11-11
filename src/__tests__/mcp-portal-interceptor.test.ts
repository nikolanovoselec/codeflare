import { describe, expect, it, vi } from 'vitest';
import { forwardMcpPortal } from '../mcp-portal-interceptor';
import { mcpPortalFixture, portal, instance, access, refresh } from './helpers/mcp-portal-fixture';
import { disconnectMcpPortal, finishMcpPortalConnect } from '../lib/mcp-portal-token';
import { setLogLevel } from '../lib/logger';
import { getMcpPortalGrant } from '../lib/mcp-portal-token';
import { SETUP_KEYS } from '../lib/kv-keys';

const props = { bucket: 'owner', portals: [portal] };
const request = (url = portal.url) => new Request(url, { method: 'POST', headers: {
  Authorization: 'Bearer codeflare-mcp-portal', 'Content-Type': 'application/json',
  'Mcp-Session-Id': 'synthetic-session', 'Mcp-Protocol-Version': '2025-03-26', 'Last-Event-ID': 'resume-2',
  Cookie: 'synthetic-agent-cookie', 'CF-Access-Jwt-Assertion': 'synthetic-forged-access',
  'X-Codeflare-Owner': 'other', 'X-API-Key': 'synthetic-alternate-token',
}, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'synthetic-write' } }) });

describe('MCP exact-destination Worker credential boundary', () => {
  it.each([
    { format: 'JWT-like', mode: 'access-only', issued: 'synthetic.jwt.signature', renewed: 'synthetic.jwt.renewed' },
    { format: 'opaque', mode: 'access-only', issued: 'synthetic-user:grant:issued+/=', renewed: 'synthetic-user:grant:renewed+/=' },
    { format: 'JWT-like', mode: 'Managed OAuth', issued: 'synthetic.jwt.signature', renewed: 'synthetic.jwt.renewed' },
    { format: 'opaque', mode: 'Managed OAuth', issued: 'synthetic-user:grant:issued+/=', renewed: 'synthetic-user:grant:renewed+/=' },
  ])('REQ-AGENT-226 AC5 / REQ-AGENT-229 AC4: $format $mode forwards the exact owner token without changing Pi credentials', async ({ mode, issued, renewed }) => {
    const f = await mcpPortalFixture();
    const renewable = mode === 'Managed OAuth';
    if (!renewable) f.withoutRefreshToken();
    f.expiry(renewable ? 30 : 3600);
    await f.begin();
    const grants: string[] = [];
    const oauth: typeof fetch = async (input, init) => {
      const wire = new Request(input, init);
      const body = new URLSearchParams(await wire.clone().text());
      const grantType = body.get('grant_type')!;
      grants.push(grantType);
      if (!renewable && grantType === 'refresh_token') throw new Error('Access-only grants must not attempt refresh');
      const response = await f.send(wire);
      return Response.json({ ...await response.json() as object,
        access_token: grantType === 'refresh_token' ? renewed : issued });
    };
    await finishMcpPortalConnect(f.env, 'owner', instance, f.authorization.searchParams.get('state')!,
      'synthetic-code', undefined, oauth);
    const saved = await getMcpPortalGrant(f.env, 'owner', portal);
    expect(saved?.tokens.access_token).toBe(issued);
    expect(saved?.tokens.refresh_token).toBe(renewable ? refresh : undefined);
    f.expiry(3600);
    const send: typeof fetch = async (input, init) => {
      const wire = new Request(input, init);
      if (wire.url !== portal.url) return oauth(wire);
      expect(wire.headers.get('Authorization')).toBe(`Bearer ${renewable ? renewed : issued}`);
      expect(wire.headers.has('Cookie')).toBe(false);
      return Response.json({ jsonrpc: '2.0', id: 1, result: { accepted: true } });
    };
    const original = request();
    const response = await forwardMcpPortal(original, f.env, props, send);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { accepted: true } });
    expect(original.headers.get('Authorization')).toBe('Bearer codeflare-mcp-portal');
    expect(grants).toEqual(renewable ? ['authorization_code', 'refresh_token'] : ['authorization_code']);
    const current = await getMcpPortalGrant(f.env, 'owner', portal);
    expect(current?.tokens.access_token).toBe(renewable ? renewed : issued);
    expect(current?.tokens.refresh_token).toBe(renewable ? refresh : undefined);
  });

  it('REQ-AGENT-229 AC4: stamps the trusted owner grant and preserves functional response streams and downstream URL context', async () => {
    const f = await mcpPortalFixture(); await f.begin(); await f.finish();
    const send: typeof fetch = async input => {
      const outgoing = input as Request;
      expect(outgoing.headers.get('Authorization')).toBe(`Bearer ${access}`);
      for (const header of ['Cookie', 'CF-Access-Jwt-Assertion', 'X-Codeflare-Owner', 'X-API-Key']) expect(outgoing.headers.has(header)).toBe(false);
      expect((await outgoing.json() as { method: string }).method).toBe('tools/call');
      expect(outgoing.redirect).toBe('manual');
      expect(outgoing.headers.get('Mcp-Session-Id')).toBe('synthetic-session');
      expect(outgoing.headers.get('Last-Event-ID')).toBe('resume-2');
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(encoder.encode('data: {"authorization_url":"https://portal.example/downstream?context=same-grant"}\n\n'));
        controller.enqueue(encoder.encode('data: {"result":"stream-complete"}\n\n')); controller.close();
      } }), { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Set-Cookie': 'never-enter-Pi=true' } });
    };
    const response = await forwardMcpPortal(request(), f.env, props, send);
    expect(response.status).toBe(200); expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    expect(response.headers.has('Set-Cookie')).toBe(false);
    const body = await response.text();
    expect(body).toContain('context=same-grant'); expect(body).toContain('stream-complete'); expect(body).not.toContain(access);
  });

  it('REQ-AGENT-229 AC4: response cancellation reaches the original upstream stream', async () => {
    const f = await mcpPortalFixture(); await f.begin(); await f.finish();
    let cancellation: unknown;
    const send: typeof fetch = async () => new Response(new ReadableStream({ cancel(reason) { cancellation = reason; } }), {
      headers: { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 'synthetic-session' },
    });
    const response = await forwardMcpPortal(request(), f.env, props, send);
    expect(response.headers.get('Mcp-Session-Id')).toBe('synthetic-session');
    await response.body!.cancel('owner-cancelled');
    expect(cancellation).toBe('owner-cancelled');
  });

  it('REQ-AGENT-229 AC2: rejects wrong resource, owner, Operator, instance, configuration, missing grant and strict-egress absence before sending', async () => {
    const f = await mcpPortalFixture(); await f.begin(); await f.finish();
    const forbidden: typeof fetch = async () => { throw Error('Protected upstream I/O must not begin'); };
    for (const url of ['https://portal.example/other', 'http://portal.example/mcp?codemode=search_and_execute',
      'https://other.example/mcp?codemode=search_and_execute', `${portal.url}&unexpected=1`]) {
      expect((await forwardMcpPortal(request(url), f.env, props, forbidden)).status).toBe(403);
    }
    expect((await forwardMcpPortal(request(), f.env, { ...props, bucket: 'other' }, forbidden)).status).toBe(401);
    expect((await forwardMcpPortal(request(), f.env, { ...props, operator: true }, forbidden)).status).toBe(403);
    expect((await forwardMcpPortal(request(), f.env, undefined, forbidden)).status).toBe(403);
    expect((await forwardMcpPortal(request(), f.env, { ...props, strict: true }, forbidden)).status).toBe(503);
    await f.kv.put(SETUP_KEYS.CUSTOM_DOMAIN, 'other-instance.example');
    expect((await forwardMcpPortal(request(), f.env, props, forbidden)).status).toBe(401);
    await f.kv.put(SETUP_KEYS.CUSTOM_DOMAIN, 'instance.example');
    await disconnectMcpPortal(f.env, 'owner', portal, f.send);
    expect((await forwardMcpPortal(request(), f.env, props, forbidden)).status).toBe(401);
    await f.kv.put(SETUP_KEYS.MCP_PORTALS, '[]');
    expect((await forwardMcpPortal(request(), f.env, props, forbidden)).status).toBe(403);
  });

  it('REQ-AGENT-229 AC4: rejects redirects without credential leakage and preserves actual upstream failure status', async () => {
    const f = await mcpPortalFixture(); await f.begin(); await f.finish();
    const response = await forwardMcpPortal(request(), f.env, props, async input => {
      expect((input as Request).redirect).toBe('manual');
      return new Response(null, { status: 307, headers: { Location: 'https://unapproved.example/mcp' } });
    });
    expect(response.status).toBe(502); expect(response.headers.has('Location')).toBe(false);
    const denied = await forwardMcpPortal(request(), f.env, props, async () => new Response('original unauthorized outcome', {
      status: 401, headers: { 'WWW-Authenticate': 'Bearer resource_metadata="https://portal.example/.well-known/oauth-protected-resource"' },
    }));
    expect(denied.status).toBe(401); expect(await denied.text()).toBe('original unauthorized outcome');
    expect(denied.headers.get('WWW-Authenticate')).toContain('portal.example');
  });

  it.each([
    ['missing', 'lookup-unavailable', undefined],
    ['lookup-throw', 'lookup-throws', undefined],
    ['no-refresh', 'no-refresh-token', undefined],
    ['oauth', 'refresh-error', 'invalid_grant'],
    ['timeout', 'refresh-error', 'timeout'],
    ['untrusted-error', 'refresh-error', 'other'],
    ['concurrent', 'concurrent-change', undefined],
    ['readback', 'readback-rejected', undefined],
  ] as const)('REQ-AGENT-226 AC6: diagnostic wire contract for %s keeps reconnect status and metadata only', async (scenario, reason, detail) => {
    const f = await mcpPortalFixture(); f.expiry(30);
    if (scenario === 'no-refresh') f.withoutRefreshToken();
    if (scenario !== 'missing') { await f.begin(); await f.finish(); }
    if (scenario === 'lookup-throw') {
      const get = f.kv.get.getMockImplementation()!;
      f.kv.get.mockImplementation(async (key, type) => {
        if (key === SETUP_KEYS.CUSTOM_DOMAIN) throw Error('SYNTHETIC-SECRET owner@example.test https://private.example');
        return get(key, type);
      });
    }
    if (scenario === 'readback') f.afterConnectionWrite(async () => { await f.kv.put(SETUP_KEYS.MCP_PORTALS, '[]'); });
    const send: typeof fetch = async (input, init) => {
      if (scenario === 'oauth') return Response.json({ error: 'invalid_grant',
        error_description: `${access} owner@example.test ${portal.url}`, error_uri: 'https://private.example/secret' }, { status: 400 });
      if (scenario === 'timeout') throw new DOMException('SYNTHETIC-SECRET owner@example.test', 'TimeoutError');
      if (scenario === 'untrusted-error') throw { errorCode: 'SYNTHETIC-SECRET', payload: access, url: portal.url };
      const response = await f.send(input, init);
      if (scenario === 'concurrent') await f.kv.put(SETUP_KEYS.MCP_PORTALS, '[]');
      return response;
    };
    const records: string[] = [];
    const output = vi.spyOn(console, 'warn').mockImplementation((line: string) => { records.push(line); });
    setLogLevel('warn');
    try {
      const response = await forwardMcpPortal(request(), f.env, props, send);
      expect(response.status).toBe(401);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toEqual({ code: 'MCP_RECONNECT_REQUIRED', error: 'MCP portal unavailable. Connect or reconnect this portal in Settings.' });
      const parsed = records.map(line => JSON.parse(line));
      for (const secret of [access, 'SYNTHETIC-SECRET', 'owner@example.test', 'https://private.example']) {
        expect(JSON.stringify(parsed)).not.toContain(secret);
      }
      // The resolver now has separate closed-stage diagnostics; the interceptor's
      // existing reason/detail envelope is intentionally unchanged.
      expect(parsed.filter(record => record.module === 'mcp-portal-interceptor').map(record => {
        expect(record.timestamp).toEqual(expect.any(String));
        return { ...record, timestamp: undefined };
      })).toEqual([{ timestamp: undefined, level: 'warn', module: 'mcp-portal-interceptor',
        message: 'MCP credential unavailable', data: { portalId: portal.name, reason, ...(detail ? { detail } : {}) } }]);
    } finally { output.mockRestore(); setLogLevel('silent'); }
  });

  it('REQ-AGENT-226 AC6: missing Settings grant polling emits no MCP request failure diagnostics', async () => {
    const f = await mcpPortalFixture(); const records: string[] = [];
    const output = vi.spyOn(console, 'warn').mockImplementation((line: string) => { records.push(line); });
    setLogLevel('warn');
    try {
      expect(await getMcpPortalGrant(f.env, 'owner', portal)).toBeNull();
      expect(records).toEqual([]);
    } finally { output.mockRestore(); setLogLevel('silent'); }
  });

  it('REQ-AGENT-229 AC5: uncertain MCP writes are never replayed after response loss', async () => {
    const f = await mcpPortalFixture(); await f.begin(); await f.finish();
    const effects: string[] = [];
    const response = await forwardMcpPortal(request(), f.env, props, async input => {
      const message = await (input as Request).json() as { method: string };
      if (message.method === 'tools/call') effects.push('synthetic-target-mutated');
      throw Error('response lost after write took effect');
    });
    expect(response.status).toBe(502);
    expect(effects).toEqual(['synthetic-target-mutated']);
  });
});
