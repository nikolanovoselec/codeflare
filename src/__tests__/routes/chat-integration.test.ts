import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../index';
import { AuthError } from '../../lib/error-types';
import { resetSetupCache } from '../../lib/cache-reset';
import { createMockKV } from '../helpers/mock-kv';
import { createMockSessionD1 } from '../helpers/mock-session-d1';
import type { Env } from '../../types';

// Codeflare-owned route contract. No Dashboard code is mocked or imported here.
// POST /api/chat/:sid/attach is explicit entry; GET /api/chat/:sid/ws and the
// component's /api/questions/:id[/answer] roads are generation-fenced forwarding.
// Attach returns the allowed Dashboard sessionId plus the container generation.
// The existing Worker fetch entrypoint must own these paths (not SPA fallback).
const boundary = vi.hoisted(() => ({
  authenticated: true, bucket: 'chat-owner', originAllowed: true,
  accessTier: 'advanced', mode: 'advanced',
  forwarded: [] as Request[], wakes: [] as string[],
  limited: false,
}));
vi.mock('../../lib/access', async original => ({
  ...await original<typeof import('../../lib/access')>(),
  authenticateRequest: async () => {
    if (!boundary.authenticated) throw new AuthError('Session expired');
    return { user: { email: 'owner@example.test', authenticated: true,
      accessTier: boundary.accessTier }, bucketName: boundary.bucket };
  },
}));
vi.mock('../../lib/cors-cache', async original => ({
  ...await original<typeof import('../../lib/cors-cache')>(),
  isAllowedOrigin: async () => boundary.originAllowed,
}));
vi.mock('../../lib/rate-limit-core', async original => ({
  ...await original<typeof import('../../lib/rate-limit-core')>(),
  checkRateLimit: async () => ({ allowed: !boundary.limited, count: 1, retryAfterSec: 60 }),
}));
vi.mock('@cloudflare/containers', async original => ({
  ...await original<typeof import('@cloudflare/containers')>(),
  getContainer: () => ({
    forwardExisting: async (request: Request) => {
      boundary.forwarded.push(request.clone());
      if (new URL(request.url).pathname === '/health') {
        return Response.json({ terminalServiceReady: true, editorReady: true });
      }
      return Response.json({ sessionId: 'live-primary-pi', generation: 7,
        path: new URL(request.url).pathname,
        headers: Object.fromEntries(request.headers) });
    },
    fetch: async () => { boundary.wakes.push('SDK fetch'); throw Error('Auto-waking transport is forbidden'); },
    start: async () => { boundary.wakes.push('start'); },
    startAndWait: async () => { boundary.wakes.push('startAndWait'); },
    getState: async () => ({ status: 'running' }),
  }),
}));

describe('Codeflare shared-primary Chat boundary', () => {
  const sid = 'abcdef0123456789';
  let kv: ReturnType<typeof createMockKV>;
  let env: Env;
  let pending: Promise<unknown>[];
  let ctx: ExecutionContext;
  const store = (change: Record<string, unknown> = {}) => kv._set(`session:chat-owner:${sid}`, {
    id: sid, userId: 'chat-owner', name: 'Configured Pi', agentType: 'pi',
    status: 'running', workspace: 'terminal', terminalMode: 'classic',
    lifecycleGeneration: 7, sessionMode: boundary.mode,
    tabConfig: [{ id: '1', command: 'pi', label: 'Pi' }],
    createdAt: '2026-10-29T00:00:00Z', lastAccessedAt: '2026-10-29T00:00:00Z', ...change,
  });
  beforeEach(() => {
    Object.assign(boundary, { authenticated: true, bucket: 'chat-owner', originAllowed: true,
      accessTier: 'advanced', mode: 'advanced', limited: false });
    boundary.forwarded.length = 0;
    boundary.wakes.length = 0;
    resetSetupCache();
    kv = createMockKV();
    kv._set('setup:complete', 'true');
    kv._set('preferences:chat-owner', { sessionMode: 'advanced' });
    env = { KV: kv, USAGE_DB: createMockSessionD1(kv), CONTAINER: {},
      ASSETS: { fetch: async () => new Response('SPA fallback') },
      ONBOARDING_LANDING_PAGE: 'inactive' } as unknown as Env;
    pending = [];
    ctx = { waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      passThroughOnException() {} } as unknown as ExecutionContext;
    store();
  });
  afterEach(async () => { await Promise.all(pending); resetSetupCache(); });
  const request = (suffix = '/attach', init: RequestInit = {}) => new Request(
    `https://codeflare.ch/api/chat/${sid}${suffix}`, {
      ...init,
      headers: { Origin: 'https://codeflare.ch', 'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/json', ...Object.fromEntries(new Headers(init.headers)) },
    });
  const attach = (generation = 7) => worker.fetch(request('/attach', {
    method: 'POST', body: JSON.stringify({ generation }),
  }), env, ctx);

  it.each([
    ['classic', 'terminal'], ['herdr', 'terminal'], ['classic', 'vscode'], ['herdr', 'vscode'],
  ])('REQ-AGENT-224: explicit %s/%s attachment preserves owner and generation without a wake', async (terminalMode, workspace) => {
    store({ terminalMode, workspace });
    const result = await attach();
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ sessionId: 'live-primary-pi', generation: 7 });
    expect(boundary.wakes).toEqual([]);
    const primary = boundary.forwarded.find(r => new URL(r.url).pathname.endsWith('/attach'))!;
    expect(new URL(primary.url).pathname).toBe(`/api/chat/${sid}/attach`);
  });

  it('REQ-AGENT-224: expired browser authentication is 401 and never reaches the runtime', async () => {
    boundary.authenticated = false;
    const result = await attach();
    expect(result.status).toBe(401);
    expect(boundary.forwarded).toEqual([]);
    expect(boundary.wakes).toEqual([]);
  });
  it('REQ-AGENT-224: another owner cannot discover or attach the primary', async () => {
    boundary.bucket = 'another-owner';
    const result = await attach();
    expect(result.status).toBe(404);
    expect(boundary.forwarded).toEqual([]);
  });
  it('REQ-AGENT-224: forbidden origin fails closed before protected I/O', async () => {
    boundary.originAllowed = false;
    const result = await attach();
    expect(result.status).toBe(403);
    expect(boundary.forwarded).toEqual([]);
  });
  it('REQ-AGENT-224: blocked accounts cannot use Chat as an entitlement bypass', async () => {
    env.SAAS_MODE = 'active';
    boundary.accessTier = 'blocked';
    const result = await attach();
    expect(result.status).toBe(403);
    expect(boundary.forwarded).toEqual([]);
  });
  it.each(['stopped', 'stopping'])('REQ-SESSION-002 / REQ-AGENT-224: %s attach and reconnect never wake compute', async status => {
    store({ status });
    for (const req of [request('/attach', { method: 'POST', body: '{"generation":7}' }),
      request('/ws?generation=7', { headers: { Upgrade: 'websocket' } })]) {
      const result = await worker.fetch(req, env, ctx);
      expect(result.status).toBe(409);
    }
    expect(boundary.forwarded).toEqual([]);
    expect(boundary.wakes).toEqual([]);
  });
  it('REQ-AGENT-224: a stale generation cannot attach or reconnect to a replacement Pi', async () => {
    expect((await attach(6)).status).toBe(409);
    expect((await worker.fetch(request('/ws?generation=6', {
      headers: { Upgrade: 'websocket' },
    }), env, ctx)).status).toBe(409);
    expect(boundary.forwarded).toEqual([]);
  });
  it.each(['claude-code', 'codex', 'bash'])('REQ-AGENT-224: %s primary is not silently replaced by Pi', async agentType => {
    store({ agentType, tabConfig: [{ id: '1', command: agentType, label: agentType }] });
    const result = await attach();
    expect(result.status).toBe(409);
    expect(boundary.forwarded).toEqual([]);
  });
  it.each(['/api/sessions', '/api/settings', '/api/providers', '/api/plugins',
    '/api/sessions/foreign/kill', '/api/questions/foreign/summarize'])
  ('REQ-AGENT-224: does not expose Dashboard management through %s', async path => {
    const result = await worker.fetch(request(path, { method: 'POST', body: '{}' }), env, ctx);
    expect([400, 403, 404]).toContain(result.status);
    expect(boundary.forwarded).toEqual([]);
  });
  it('REQ-AGENT-224: rate-limited reconnect returns 429 without opening a runtime wire', async () => {
    boundary.limited = true;
    const result = await worker.fetch(request('/ws?generation=7', {
      headers: { Upgrade: 'websocket' },
    }), env, ctx);
    expect(result.status).toBe(429);
    expect(boundary.forwarded.filter(r => new URL(r.url).pathname !== '/health')).toEqual([]);
  });
  it('REQ-AGENT-224: bounded attach rejects oversized bodies before forwarding', async () => {
    const result = await worker.fetch(request('/attach', {
      method: 'POST', body: JSON.stringify({ generation: 7, padding: 'x'.repeat(1024 * 1024 + 1) }),
    }), env, ctx);
    expect(result.status).toBe(413);
    expect(boundary.forwarded).toEqual([]);
  });
  it('REQ-AGENT-224: browser cannot select a secondary or supply automatic-answer authority at attach', async () => {
    const result = await worker.fetch(request('/attach', {
      method: 'POST', body: JSON.stringify({ generation: 7, sessionId: 'secondary', automatic: true }),
    }), env, ctx);
    expect(result.status).toBe(400);
    expect(boundary.forwarded).toEqual([]);
  });
  it.each([
    ['/api/questions/question-a?generation=7', 'GET', undefined],
    ['/api/questions/question-a/answer?generation=7', 'POST', { answer: 'A manual answer' }],
    ['/api/questions/question-a/answer?generation=7', 'POST', { cancelled: true }],
  ] as const)('REQ-AGENT-224: forwards only the component-needed %s road through the owned session boundary', async (path, method, body) => {
    const result = await worker.fetch(request(path, { method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env, ctx);
    expect(result.status).toBe(200);
    const observed = boundary.forwarded.find(r => new URL(r.url).pathname.includes('/api/questions/'))!;
    expect(new URL(observed.url).pathname).toBe(`/api/chat/${sid}${path.split('?')[0]}`);
    expect(observed.method).toBe(method);
    if (body !== undefined) expect(await observed.json()).toEqual(body);
  });
  it('REQ-AGENT-224: stale question answers cannot affect a replacement generation', async () => {
    const result = await worker.fetch(request('/api/questions/question-a/answer?generation=6', {
      method: 'POST', body: JSON.stringify({ answer: 'Stale answer' }),
    }), env, ctx);
    expect(result.status).toBe(409);
    expect(boundary.forwarded).toEqual([]);
  });
  it('REQ-AGENT-224: browser answer envelopes cannot claim automatic provenance or another primary', async () => {
    const result = await worker.fetch(request('/api/questions/question-a/answer?generation=7', {
      method: 'POST', body: JSON.stringify({ answer: 'Recommended', automatic: true, source: 'timeout', sessionId: 'foreign' }),
    }), env, ctx);
    expect(result.status).toBe(400);
    expect(boundary.forwarded).toEqual([]);
  });
  it.each([null, {}, { generation: -1 }, { generation: '7' }, { generation: 1.5 }])(
    'REQ-AGENT-224: invalid attachment generation %j is rejected before runtime I/O', async body => {
      const result = await worker.fetch(request('/attach', { method: 'POST', body: JSON.stringify(body) }), env, ctx);
      expect(result.status).toBe(400);
      expect(boundary.forwarded).toEqual([]);
    });
  it('REQ-AGENT-224: GET cannot perform explicit primary entry', async () => {
    const result = await worker.fetch(request('/attach'), env, ctx);
    expect(result.status).toBe(405);
    expect(boundary.forwarded).toEqual([]);
  });
  it('REQ-AGENT-224: replaces spoofed forwarding identity before the protected Host hop', async () => {
    const result = await worker.fetch(request('/attach', { method: 'POST', body: '{"generation":7}',
      headers: { Forwarded: 'host=evil.test', 'X-Forwarded-Host': 'evil.test', 'X-Forwarded-Proto': 'http' },
    }), env, ctx);
    expect(result.status).toBe(200);
    const projection = await result.json() as { headers: Record<string, string> };
    expect(projection.headers.forwarded).toBeUndefined();
    expect(projection.headers['x-forwarded-host']).toBe('codeflare.ch');
    expect(projection.headers['x-forwarded-proto']).toBe('https');
  });
});
