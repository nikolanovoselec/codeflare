import { describe, expect, it } from 'vitest';
import { forwardMcpPortal } from '../mcp-portal-interceptor';
import { mcpPortalFixture, portal, access } from './helpers/mcp-portal-fixture';
import { disconnectMcpPortal } from '../lib/mcp-portal-token';
import { SETUP_KEYS } from '../lib/kv-keys';

const props = { bucket: 'owner', portals: [portal] };
const request = (url = portal.url) => new Request(url, { method: 'POST', headers: {
  Authorization: 'Bearer codeflare-mcp-portal', 'Content-Type': 'application/json',
  'Mcp-Session-Id': 'synthetic-session', 'Mcp-Protocol-Version': '2025-03-26', 'Last-Event-ID': 'resume-2',
  Cookie: 'synthetic-agent-cookie', 'CF-Access-Jwt-Assertion': 'synthetic-forged-access',
  'X-Codeflare-Owner': 'other', 'X-API-Key': 'synthetic-alternate-token',
}, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'synthetic-write' } }) });

describe('MCP exact-destination Worker credential boundary', () => {
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
