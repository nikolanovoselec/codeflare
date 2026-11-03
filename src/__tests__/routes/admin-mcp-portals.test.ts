import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { createMockKV } from '../helpers/mock-kv';
import { SETUP_KEYS } from '../../lib/kv-keys';

let role = 'admin';
vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    if (role === 'anonymous') return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', { email: 'admin@example.com', authenticated: true, role });
    return next();
  },
  requireAdmin: async (c: any, next: any) => c.get('user')?.role === 'admin' ? next() : c.json({ error: 'Forbidden' }, 403),
}));
import configuration from '../../routes/admin/configuration';

const endpoint = '/admin/configuration/mcp-portals';
const portals = [
  { name: 'codeflare_enterprise', url: 'https://portal.example.com/mcp?codemode=search_and_execute' },
  { name: 'github', url: 'https://api.githubcopilot.com/mcp/' },
];
function fixture() {
  const kv = createMockKV();
  const forbiddenExternalAction = () => { throw new Error('Unexpected external action'); };
  const env = { KV: kv, CONTAINER: { get: forbiddenExternalAction, idFromName: forbiddenExternalAction } } as unknown as Env;
  const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
  app.use('*', async (c, next) => { c.env = env; await next(); });
  app.route('/admin/configuration', configuration);
  return { kv, app, read: () => app.request(endpoint), save: (value: unknown) => app.request(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }) };
}

describe('instance MCP portal configuration', () => {
  beforeEach(() => { role = 'admin'; vi.stubGlobal('fetch', () => { throw new Error('No network allowed on configuration save'); }); });
  afterEach(() => vi.unstubAllGlobals());

  it('REQ-AGENT-227 AC2: authorized validated configuration persists without secrets or external actions', async () => {
    const instance = fixture();
    const other = fixture();
    expect(await (await instance.read()).json()).toEqual([]);
    expect(await (await instance.save(portals)).json()).toEqual(portals);
    expect(await instance.kv.get(SETUP_KEYS.MCP_PORTALS, 'json')).toEqual(portals);
    expect(await (await instance.read()).json()).toEqual(portals);
    expect(await (await other.read()).json()).toEqual([]);
    const edited = [{ ...portals[0], url: 'https://portal.example.com:443/updated/mcp?codemode=search_and_execute' }];
    expect(await (await instance.save(edited)).json()).toEqual(edited);
    expect(await (await instance.read()).json()).toEqual(edited);
    expect((await instance.save([])).status).toBe(200);
    expect(await (await instance.read()).json()).toEqual([]);
  });

  it.each(['user', 'anonymous'])('REQ-AGENT-227 AC1: denies %s read and write', async (deniedRole) => {
    const instance = fixture();
    await instance.save(portals);
    role = deniedRole;
    const status = role === 'anonymous' ? 401 : 403;
    expect((await instance.read()).status).toBe(status);
    expect((await instance.save([])).status).toBe(status);
    role = 'admin';
    expect(await (await instance.read()).json()).toEqual(portals);
  });

  it.each(([
    [{ name: 'github', url: 'http://portal.example.com/mcp' }],
    ...['https://127.0.0.1/mcp', 'https://[::1]/mcp', 'https://portal/mcp', 'https://portal.local/mcp',
      'https://portal.internal/mcp', 'https://portal.localhost/mcp', 'https://portal.example.com:8443/mcp']
      .map(url => [{ name: 'github', url }]),
    [{ name: 'github', url: 'https://owner:password@portal.example.com/mcp' }],
    [{ name: 'github', url: 'https://portal.example.com/mcp#token' }],
    [{ name: 'github', url: 'https://portal.example.com/mcp?api_key=secret' }],
    [{ name: 'github', url: 'https://portal.example.com/mcp?token=secret' }],
    [{ name: 'github', url: 'https://portal.example.com/mcp?codemode=search_and_execute&codemode=search_and_execute' }],
    [{ name: 'github', url: 'not a URL' }],
    [{ name: 'github', url: `https://portal.example.com/${'x'.repeat(512)}` }],
    [{ name: '../github', url: portals[1].url }],
    [{ name: 'GitHub', url: portals[1].url }],
    [{ name: '', url: portals[1].url }],
    [portals[1], portals[1]],
    [{ ...portals[1], apiKey: 'secret' }],
    { portals },
  ] as unknown[]).map((invalid) => [invalid]))('REQ-AGENT-227 AC2: rejects invalid or credential-bearing configuration %#', async (invalid) => {
    const instance = fixture();
    await instance.save(portals);
    expect((await instance.save(invalid)).status).toBe(400);
    expect(await (await instance.read()).json()).toEqual(portals);
  });

  it('REQ-AGENT-227 AC3: saving does not mutate running sessions or grants', async () => {
    const instance = fixture();
    const running = { id: 'running', state: 'active', config: { mcpServers: { custom: { url: 'https://custom.example/mcp' } } } };
    await instance.kv.put('session:running', JSON.stringify(running));
    await instance.kv.put('oauth:existing', 'existing-owner-grant');
    const response = await instance.save(portals);
    expect(response.status).toBe(200);
    expect(await instance.kv.get('session:running', 'json')).toEqual(running);
    expect(await instance.kv.get('oauth:existing')).toBe('existing-owner-grant');
  });
});
