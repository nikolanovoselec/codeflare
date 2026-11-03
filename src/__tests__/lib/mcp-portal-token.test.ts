import { describe, expect, it, vi } from 'vitest';
import { mcpPortalFixture, portal, instance, access, refresh } from '../helpers/mcp-portal-fixture';
import { beginMcpPortalConnect, finishMcpPortalConnect, getMcpPortalGrant, getValidMcpPortalToken, disconnectMcpPortal,
  portalOAuthFetch, publicHttps } from '../../lib/mcp-portal-token';
import { SETUP_KEYS } from '../../lib/kv-keys';

describe('Worker-owned MCP portal OAuth', () => {
  it('REQ-AGENT-226 AC1: standard OAuth PKCE exchange stores only encrypted owner/portal grants', async () => {
    const f = await mcpPortalFixture();
    const url = await f.begin();
    expect(url.origin).toBe('https://portal.example');
    expect(url.searchParams.get('redirect_uri')).toBe(`${instance}/auth/mcp/callback`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('resource')).toBe('https://portal.example/mcp');
    await f.finish();
    expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBe(access);
    const keys = await f.kv.list({ prefix: 'mcp-portal:' });
    expect(keys.keys.length).toBeGreaterThan(0);
    for (const key of keys.keys) {
      const stored = await f.kv.get(key.name);
      if (typeof stored !== 'string') throw new Error('Encrypted KV record must be a string');
      expect(stored.startsWith('v1:')).toBe(true);
      expect(stored).not.toContain(access); expect(stored).not.toContain(refresh);
    }
    expect(await getMcpPortalGrant(f.env, 'other-owner', portal)).toBeNull();
    expect(await getMcpPortalGrant(f.env, 'owner', { ...portal, url: 'https://other.example/mcp' })).toBeNull();
  });

  it('REQ-AGENT-226 AC1: public client metadata registration uses the same bound callback without a second OAuth issuer', async () => {
    const f = await mcpPortalFixture(); f.cimd();
    const authorization = await f.begin();
    expect(authorization.searchParams.get('client_id')).toBe(`${instance}/auth/mcp/client-metadata`);
    await f.finish();
    expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBe(access);
  });

  it('REQ-AGENT-226 AC1: dynamic registration works when instance Access prevents metadata-client use', async () => {
    const f = await mcpPortalFixture(); f.bothRegistrations();
    const authorization = await f.begin();
    expect(authorization.searchParams.get('client_id')).toBe('synthetic-client');
    await f.finish();
    expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBe(access);
  });

  it('REQ-AGENT-226 AC2: expired pending state cannot create a grant', async () => {
    const f = await mcpPortalFixture(); await f.begin();
    const now = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 300_001);
    try { await expect(f.finish()).rejects.toThrow(); }
    finally { clock.mockRestore(); }
    expect(await getMcpPortalGrant(f.env, 'owner', portal)).toBeNull();
  });

  it('REQ-AGENT-226 AC2: callback rejects owner, instance, state, issuer, configuration and replay mismatches', async () => {
    const f = await mcpPortalFixture(); await f.begin();
    const state = f.authorization.searchParams.get('state')!;
    for (const [owner, origin, nonce, issuer] of [
      ['other', instance, state, undefined], ['owner', 'https://other.example', state, undefined],
      ['owner', instance, 'b'.repeat(64), undefined], ['owner', instance, state, 'https://other.example'],
    ] as const) await expect(finishMcpPortalConnect(f.env, owner, origin, nonce, 'synthetic-code', issuer, f.send)).rejects.toThrow();
    await f.finish();
    await expect(f.finish()).rejects.toThrow();
    const changed = await mcpPortalFixture(); await changed.begin();
    await changed.kv.put(SETUP_KEYS.MCP_PORTALS, JSON.stringify([{ ...portal, url: 'https://changed.example/mcp' }]));
    await expect(changed.finish()).rejects.toThrow();
    expect(await getMcpPortalGrant(changed.env, 'owner', portal)).toBeNull();
  });

  it('REQ-AGENT-226 AC2: cancellation consumes state without creating a grant', async () => {
    const f = await mcpPortalFixture(); await f.begin();
    await expect(finishMcpPortalConnect(f.env, 'owner', instance, f.authorization.searchParams.get('state')!, null, undefined, f.send)).rejects.toThrow();
    await expect(f.finish()).rejects.toThrow();
    expect(await getMcpPortalGrant(f.env, 'owner', portal)).toBeNull();
  });

  it.each(['during-discovery', 'before-callback'] as const)('REQ-AGENT-226 AC2: disconnect %s cancels the older flow before token issuance', async timing => {
    const f = await mcpPortalFixture();
    if (timing === 'during-discovery') f.beforeDiscovery(() => disconnectMcpPortal(f.env, 'owner', portal, f.send));
    await f.begin();
    if (timing === 'before-callback') await disconnectMcpPortal(f.env, 'owner', portal, f.send);
    await expect(f.finish()).rejects.toThrow(/connection changed/);
    expect(f.issuedForCode('synthetic-code')).toBeUndefined();
    expect(await getMcpPortalGrant(f.env, 'owner', portal)).toBeNull();
  });

  it('REQ-AGENT-226 AC4: encryption is mandatory and ciphertext cannot move between owner records', async () => {
    const f = await mcpPortalFixture();
    await expect(beginMcpPortalConnect({ ...f.env, ENCRYPTION_KEY: undefined }, 'owner', portal, instance, f.send)).rejects.toThrow(/encryption/);
    await f.begin(); await f.finish();
    const key = (await f.kv.list({ prefix: 'mcp-portal:owner:' })).keys[0]!.name;
    const ciphertext = await f.kv.get(key);
    if (typeof ciphertext !== 'string') throw new Error('Encrypted KV record must be a string');
    await f.kv.put(key.replace(':owner:owner:', ':owner:other:'), ciphertext);
    expect(await getMcpPortalGrant(f.env, 'other', portal)).toBeNull();
    await f.kv.put(key, JSON.stringify({ grant: { tokens: { access_token: access } } }));
    expect(await getMcpPortalGrant(f.env, 'owner', portal)).toBeNull();
  });

  it('REQ-AGENT-226 AC5: current grant refresh rotates without interactive Pi authorization', async () => {
    const f = await mcpPortalFixture(); f.expiry(30); await f.begin(); await f.finish();
    f.expiry(3600);
    expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBe(`${access}-ROTATED`);
    expect((await getMcpPortalGrant(f.env, 'owner', portal))?.tokens.refresh_token).toBe(refresh);
    expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBe(`${access}-ROTATED`);
  });

  it('REQ-AGENT-226 AC5: refresh token omission still permits the next silent renewal', async () => {
    const f = await mcpPortalFixture(); f.expiry(30); await f.begin(); await f.finish();
    f.omitRefreshOnRenewal();
    expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBe(`${access}-ROTATED`);
    expect((await getMcpPortalGrant(f.env, 'owner', portal))?.tokens.refresh_token).toBe(refresh);
    f.expiry(3600);
    expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBe(`${access}-ROTATED`);
  });

  it('REQ-AGENT-226 AC6: refresh failure and observed disconnect during refresh fail closed', async () => {
    const failed = await mcpPortalFixture(); failed.expiry(30); await failed.begin(); await failed.finish(); failed.rejectRefresh();
    expect(await getValidMcpPortalToken(failed.env, 'owner', portal, failed.send)).toBeNull();
    const f = await mcpPortalFixture(); f.expiry(30); await f.begin(); await f.finish();
    f.beforeToken(() => disconnectMcpPortal(f.env, 'owner', portal, f.send));
    expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBeNull();
    expect(await getMcpPortalGrant(f.env, 'owner', portal)).toBeNull();
  });

  it.each([[30, false], [3600, false], [30, true], [3600, true]] as const)('REQ-AGENT-226 AC5: racing rotating refreshes reuse only the current generation with lifetime=%s (disconnect=%s)', async (lifetime, disconnect) => {
    const f = await mcpPortalFixture(); f.expiry(30); await f.begin(); await f.finish();
    f.expiry(lifetime); f.rotateRefresh();
    let arrived = 0, releaseRequests!: () => void, publishWinner!: () => void;
    const bothRequests = new Promise<void>(resolve => { releaseRequests = resolve; });
    const winnerPublished = new Promise<void>(resolve => { publishWinner = resolve; });
    // Rendezvous at the provider: both requests have observed the same old grant.
    f.beforeToken(async () => { if (++arrived === 2) releaseRequests(); await bothRequests; });
    f.beforeRefreshRejection(async () => { await winnerPublished; });
    const requests = [getValidMcpPortalToken(f.env, 'owner', portal, f.send), getValidMcpPortalToken(f.env, 'owner', portal, f.send)];
    expect(await Promise.race(requests)).toBe(`${access}-ROTATED`);
    if (disconnect) await disconnectMcpPortal(f.env, 'owner', portal, f.send);
    publishWinner();
    const results = await Promise.all(requests);
    if (disconnect) {
      expect(results).toContain(null);
      expect(await getMcpPortalGrant(f.env, 'owner', portal)).toBeNull();
    } else {
      expect(results).toEqual([`${access}-ROTATED`, `${access}-ROTATED`]);
      expect((await getMcpPortalGrant(f.env, 'owner', portal))?.tokens.refresh_token).toBe(`${refresh}-ROTATED`);
    }
  });

  it('REQ-AGENT-226 AC7: disconnect affects only selected owner/portal and never restores failed revocation', async () => {
    const f = await mcpPortalFixture(); await f.begin(); await f.finish(); await f.begin('other'); await f.finish('other');
    await f.kv.put('deploy-keys:owner', 'unrelated-GitHub-Cloudflare-state');
    const unavailable: typeof fetch = async () => { throw Error('revocation unavailable'); };
    await disconnectMcpPortal(f.env, 'owner', portal, unavailable);
    expect(await getMcpPortalGrant(f.env, 'owner', portal)).toBeNull();
    expect(await getValidMcpPortalToken(f.env, 'other', portal, f.send)).toBe(access);
    expect(await f.kv.get('deploy-keys:owner')).toBe('unrelated-GitHub-Cloudflare-state');
  });

  it('REQ-AGENT-226 AC1: OAuth rejects issuer/resource mismatch, unsafe URLs and redirects before credential exchange', async () => {
    for (const mismatch of ['issuer', 'resource'] as const) {
      const f = await mcpPortalFixture(); f[mismatch]('https://other.example/mcp');
      await expect(f.begin()).rejects.toThrow(/mismatch/);
    }
    for (const url of ['http://portal.example/token', 'https://owner:password@portal.example/token', 'https://127.0.0.1/token', 'https://localhost/token']) expect(() => publicHttps(url)).toThrow();
    const redirect: typeof fetch = async () => new Response(null, { status: 302, headers: { Location: 'https://other.example/token' } });
    await expect(portalOAuthFetch(redirect)('https://portal.example/token', { method: 'POST', body: 'synthetic-secret' })).rejects.toThrow(/redirect/);
  });
});
