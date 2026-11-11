import { describe, expect, it, vi } from 'vitest';
import { mcpPortalFixture, portal, instance, access, refresh } from '../helpers/mcp-portal-fixture';
import { beginMcpPortalConnect, finishMcpPortalConnect, getMcpPortalGrant, getValidMcpPortalToken, disconnectMcpPortal,
  portalOAuthFetch, publicHttps } from '../../lib/mcp-portal-token';
import { SETUP_KEYS } from '../../lib/kv-keys';
import { decryptFromKV, getOrImportKey } from '../../lib/kv-crypto';
import { setLogLevel } from '../../lib/logger';

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

  it('REQ-AGENT-226 AC4: grant lookup uses one ciphertext snapshot, never a later plaintext substitute', async () => {
    const f = await mcpPortalFixture();
    await f.begin(); await f.finish();
    const key = 'mcp-portal:owner:owner:portal:fixture';
    const ciphertext = await f.kv.get(key) as string;
    const cryptoKey = (await getOrImportKey(f.env))!;
    const plaintext = await decryptFromKV(ciphertext.slice(3), cryptoKey, key);
    const originalGet = f.kv.get.getMockImplementation()!;
    let delivered = false;
    f.kv.get.mockImplementation(async (name, type) => {
      if (name !== key) return originalGet(name, type);
      if (!delivered) { delivered = true; return ciphertext; }
      // Model a different value on a hypothetical second fetch. This grant
      // remains correctly bound so only the ciphertext boundary rejects it.
      const substitute = JSON.parse(plaintext);
      substitute.grant.tokens.access_token = 'SYNTHETIC-PLAINTEXT-SUBSTITUTE';
      return JSON.stringify(substitute);
    });
    const before = f.kv._store.get(key);
    expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBe(access);
    expect(f.kv._store.get(key)).toBe(before);
  });

  it.each(['plaintext', 'malformed', 'wrong-key'] as const)(
    'REQ-AGENT-226 AC4: %s grants are unusable without migration writes', async kind => {
      const f = await mcpPortalFixture();
      await f.begin(); await f.finish();
      const key = 'mcp-portal:owner:owner:portal:fixture';
      const ciphertext = await f.kv.get(key) as string;
      if (kind === 'plaintext') {
        const cryptoKey = (await getOrImportKey(f.env))!;
        await f.kv.put(key, await decryptFromKV(ciphertext.slice(3), cryptoKey, key));
      } else if (kind === 'malformed') {
        await f.kv.put(key, 'v1:not-valid-ciphertext');
      } else {
        f.env.ENCRYPTION_KEY = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
      }
      const before = f.kv._store.get(key);
      expect(await getMcpPortalGrant(f.env, 'owner', portal)).toBeNull();
      expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBeNull();
      expect(f.kv._store.get(key)).toBe(before);
    }
  );

  it.each(['changed', 'removed'] as const)('REQ-AGENT-227 AC4: %s destinations invalidate a previously saved grant', async change => {
    const f = await mcpPortalFixture();
    await f.begin(); await f.finish();
    expect((await getMcpPortalGrant(f.env, 'owner', portal))?.tokens.access_token).toBe(access);
    expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBe(access);

    const replacement = { ...portal, url: 'https://changed.example/mcp' };
    await f.kv.put(SETUP_KEYS.MCP_PORTALS, JSON.stringify(change === 'changed' ? [replacement] : []));
    const forbidden: typeof fetch = async () => { throw Error('Invalidated grants must not initiate provider I/O'); };
    expect(await getMcpPortalGrant(f.env, 'owner', portal)).toBeNull();
    expect(await getValidMcpPortalToken(f.env, 'owner', portal, forbidden)).toBeNull();
    if (change === 'changed') {
      expect(await getMcpPortalGrant(f.env, 'owner', replacement)).toBeNull();
      expect(await getValidMcpPortalToken(f.env, 'owner', replacement, forbidden)).toBeNull();
    }
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

  it('REQ-AGENT-226 AC5: successful refresh reuses an observed same-generation renewal before publication', async () => {
    const f = await mcpPortalFixture(); f.expiry(30); await f.begin(); await f.finish();
    const old = await f.connectionSnapshot();
    f.expiry(3600);
    expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBe(`${access}-ROTATED`);
    const winner = await f.connectionSnapshot();
    f.readConnection(old);
    const send: typeof fetch = async (input, init) => {
      const response = await f.send(input, init);
      f.readConnection(winner); return response;
    };
    expect(await getValidMcpPortalToken(f.env, 'owner', portal, send)).toBe(`${access}-ROTATED`);
    f.readConnection(undefined);
    expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBe(`${access}-ROTATED`);
  });

  it('REQ-AGENT-226 AC5: stale encrypted readback after refresh publication never returns the old access token', async () => {
    const f = await mcpPortalFixture(); f.expiry(30); await f.begin(); await f.finish();
    const old = await f.connectionSnapshot(); f.expiry(3600);
    f.afterConnectionWrite(async () => { f.readConnection(old); });
    expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBe(`${access}-ROTATED`);
    f.readConnection(undefined);
    expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBe(`${access}-ROTATED`);
  });

  it.each(['disconnect', 'configuration', 'generation'] as const)(
    'REQ-AGENT-226 AC6: observed %s after refresh publication rejects the refresh result', async change => {
      const f = await mcpPortalFixture(); f.expiry(30); await f.begin(); await f.finish(); f.expiry(3600);
      f.afterConnectionWrite(async () => {
        if (change === 'disconnect') await disconnectMcpPortal(f.env, 'owner', portal, f.send);
        if (change === 'configuration') await f.kv.put(SETUP_KEYS.MCP_PORTALS, '[]');
        if (change === 'generation') { await f.begin(); await f.finish(); }
      });
      expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBeNull();
    });

  it.each(['configuration', 'generation'] as const)(
    'REQ-AGENT-226 AC6: observed %s before refresh publication rejects the refresh result', async change => {
      const f = await mcpPortalFixture(); f.expiry(30); await f.begin(); await f.finish(); f.expiry(3600);
      const send: typeof fetch = async (input, init) => {
        const response = await f.send(input, init);
        if (change === 'configuration') await f.kv.put(SETUP_KEYS.MCP_PORTALS, '[]');
        else { await f.begin(); await f.finish(); }
        return response;
      };
      expect(await getValidMcpPortalToken(f.env, 'owner', portal, send)).toBeNull();
    });

  it.each(['before', 'after'] as const)(
    'REQ-AGENT-226 AC6: an expired same-generation renewal observed %s publication is unusable', async timing => {
      const f = await mcpPortalFixture(); f.expiry(30); await f.begin(); await f.finish();
      const old = await f.connectionSnapshot();
      expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBe(`${access}-ROTATED`);
      const expiredRenewal = await f.connectionSnapshot();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
      try {
        f.readConnection(old); f.expiry(3600);
        if (timing === 'after') f.afterConnectionWrite(async () => { f.readConnection(expiredRenewal); });
        const send: typeof fetch = async (input, init) => {
          const response = await f.send(input, init);
          if (timing === 'before') f.readConnection(expiredRenewal);
          return response;
        };
        expect(await getValidMcpPortalToken(f.env, 'owner', portal, send)).toBeNull();
      } finally { clock.mockRestore(); f.readConnection(undefined); }
    });

  it('REQ-AGENT-226 AC6: rotating refresh rejection before winner publication never falls back to the old token', async () => {
    const f = await mcpPortalFixture(); f.expiry(30); await f.begin(); await f.finish();
    const old = await f.connectionSnapshot(); f.rotateRefresh(); f.expiry(3600);
    expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBe(`${access}-ROTATED`);
    f.readConnection(old);
    expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBeNull();
    f.readConnection(undefined);
    expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBe(`${access}-ROTATED`);
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


describe('Generation-fenced MCP recovery entry', () => {
  it.each(['missing', 'tombstone', 'generation', 'configuration', 'other-owner'] as const)(
    'REQ-AGENT-226 AC6 / REQ-AGENT-228 AC4: expected recovery generation rejects %s before provider I/O', async change => {
      const f = await mcpPortalFixture(); await f.begin(); await f.finish();
      const original = (await getMcpPortalGrant(f.env, 'owner', portal))!;
      if (change === 'missing') await f.kv.delete('mcp-portal:owner:owner:portal:fixture');
      if (change === 'tombstone') await disconnectMcpPortal(f.env, 'owner', portal, f.send);
      if (change === 'generation') { await f.begin(); await f.finish(); }
      if (change === 'configuration') await f.kv.put(SETUP_KEYS.MCP_PORTALS, '[]');
      const forbidden: typeof fetch = async () => { throw Error('Unexpected provider I/O'); };
      await expect(beginMcpPortalConnect(f.env, change === 'other-owner' ? 'other' : 'owner', portal, instance, forbidden, original.id))
        .rejects.toThrow(/MCP (connection|portal configuration) changed/);
      expect((await f.kv.list({ prefix: 'mcp-portal:pending:' })).keys).toHaveLength(0);
    });

  it.each(['disconnect', 'configuration', 'generation'] as const)(
    'REQ-AGENT-226 AC6: observed %s during recovery discovery cannot mint a pending authorization', async change => {
      const f = await mcpPortalFixture(); await f.begin(); await f.finish();
      const original = (await getMcpPortalGrant(f.env, 'owner', portal))!;
      f.beforeDiscovery(async () => {
        if (change === 'disconnect') await disconnectMcpPortal(f.env, 'owner', portal, f.send);
        if (change === 'configuration') await f.kv.put(SETUP_KEYS.MCP_PORTALS, '[]');
        if (change === 'generation') { await f.begin(); await f.finish(); }
      });
      await expect(beginMcpPortalConnect(f.env, 'owner', portal, instance, f.send, original.id)).rejects.toThrow(/connection changed/);
      expect((await f.kv.list({ prefix: 'mcp-portal:pending:' })).keys).toHaveLength(0);
      if (change !== 'generation') expect(await getMcpPortalGrant(f.env, 'owner', portal)).toBeNull();
    });

  it.each(['disconnect', 'configuration', 'generation'] as const)(
    'REQ-AGENT-226 AC6: observed %s after recovery begin cannot replace the current connection at callback', async change => {
      const f = await mcpPortalFixture(); await f.begin(); await f.finish();
      const original = (await getMcpPortalGrant(f.env, 'owner', portal))!;
      const authorization = new URL(await beginMcpPortalConnect(f.env, 'owner', portal, instance, f.send, original.id));
      if (change === 'disconnect') await disconnectMcpPortal(f.env, 'owner', portal, f.send);
      if (change === 'configuration') await f.kv.put(SETUP_KEYS.MCP_PORTALS, '[]');
      if (change === 'generation') { await f.begin(); await f.finish(); }
      await expect(finishMcpPortalConnect(f.env, 'owner', instance, authorization.searchParams.get('state')!, 'synthetic-code', undefined, f.send)).rejects.toThrow();
      const current = await getMcpPortalGrant(f.env, 'owner', portal);
      if (change === 'generation') expect(current?.id).not.toBe(original.id);
      else expect(current).toBeNull();
    });
});

// Intentional observability contracts, not a functional RED gate. All provider
// traffic stays inside the existing synthetic OAuth fixture.
describe('MCP OAuth fixed-stage confidentiality contract', () => {
  const secret = 'SYNTHETIC-PRIVATE owner-private@example.test https://private.example/token?code=PRIVATE';
  async function capture(action: () => Promise<void>) {
    const lines: string[] = [];
    const spies = (['log', 'warn', 'error'] as const).map(level => vi.spyOn(console, level)
      .mockImplementation(line => { lines.push(String(line)); }));
    setLogLevel('info');
    try {
      await action();
      const records = lines.map(line => JSON.parse(line));
      const text = JSON.stringify(records);
      for (const forbidden of [secret, access, refresh, 'synthetic-code', 'owner-private@example.test', 'https://private.example']) {
        expect(text).not.toContain(forbidden);
      }
      for (const record of records) {
        expect(Object.keys(record).sort()).toEqual(['data', 'level', 'message', 'module', 'timestamp']);
        expect(record.module).toBe('mcp-portal-oauth');
        expect(record.message).toBe('MCP OAuth outcome');
        expect(Object.keys(record.data).sort()).toEqual(record.data.detail === undefined
          ? ['operation', 'outcome', 'stage'] : ['detail', 'operation', 'outcome', 'stage']);
      }
      return records.map(record => record.data);
    } finally { spies.forEach(spy => spy.mockRestore()); setLogLevel('silent'); }
  }
  const path = (input: RequestInfo | URL) => new URL(input instanceof Request ? input.url : String(input)).pathname;

  it('emits completed callback publication and renewal outcomes without credentials or state', async () => {
    const f = await mcpPortalFixture(); f.expiry(30);
    const records = await capture(async () => {
      await f.begin(); await f.finish(); f.expiry(3600);
      expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBe(`${access}-ROTATED`);
    });
    expect(records).toEqual([
      { operation: 'connect', stage: 'pending-publication', outcome: 'completed' },
      { operation: 'callback', stage: 'grant-publication', outcome: 'completed' },
      { operation: 'renewal', stage: 'readback', outcome: 'completed' },
    ]);
    expect(JSON.stringify(records)).not.toContain(f.authorization.searchParams.get('state')!);
  });

  it.each(['invalid_client_metadata', 'timeout', 'untrusted'] as const)(
    'classifies DCR %s without serializing provider error material', async failure => {
      const f = await mcpPortalFixture();
      const injected = failure === 'timeout' ? new DOMException(secret, 'TimeoutError')
        : { errorCode: secret, message: secret, stack: secret, headers: { Cookie: secret } };
      const send: typeof fetch = async (input, init) => {
        if (path(input) !== '/register') return f.send(input, init);
        if (failure !== 'invalid_client_metadata') throw injected;
        return Response.json({ error: failure, error_description: secret, error_uri: secret }, { status: 400 });
      };
      const records = await capture(async () => {
        await expect(beginMcpPortalConnect(f.env, 'owner', portal, instance, send)).rejects.toBeDefined();
        expect(await getMcpPortalGrant(f.env, 'owner', portal)).toBeNull();
      });
      expect(records).toEqual([{ operation: 'connect', stage: 'registration', outcome: 'rejected',
        detail: failure === 'untrusted' ? 'other' : failure }]);
    });

  it.each(['exchange', 'timeout', 'invalid-token', 'publication', 'cancelled', 'binding'] as const)(
    'retains the actual callback failure stage for %s and saves no usable grant', async failure => {
      const f = await mcpPortalFixture(); await f.begin();
      const state = f.authorization.searchParams.get('state')!;
      if (failure === 'publication') {
        const put = f.kv.put.getMockImplementation()!;
        f.kv.put.mockImplementation(async (key, value, options) => {
          if (key.startsWith('mcp-portal:owner:')) throw Error(secret);
          return put(key, value, options);
        });
      }
      const send: typeof fetch = async (input, init) => {
        if (path(input) !== '/token') return f.send(input, init);
        if (failure === 'exchange') return Response.json({ error: 'invalid_grant', error_description: secret }, { status: 400 });
        if (failure === 'timeout') throw new DOMException(secret, 'TimeoutError');
        if (failure === 'invalid-token') return Response.json({ access_token: 'not a bearer', token_type: 'Bearer' });
        return f.send(input, init);
      };
      const records = await capture(async () => {
        await expect(finishMcpPortalConnect(f.env, failure === 'binding' ? 'other-owner' : 'owner', instance, state,
          failure === 'cancelled' ? null : 'synthetic-code', undefined, send)).rejects.toBeDefined();
        expect(await getMcpPortalGrant(f.env, 'owner', portal)).toBeNull();
      });
      const stages = { exchange: 'code-exchange', timeout: 'code-exchange', 'invalid-token': 'token-validation',
        publication: 'grant-publication', cancelled: 'authorization-response', binding: 'state-binding' };
      expect(records).toEqual([{ operation: 'callback', stage: stages[failure], outcome: 'rejected',
        detail: failure === 'exchange' ? 'invalid_grant' : failure === 'timeout' ? 'timeout' : 'other' }]);
      expect(JSON.stringify(records)).not.toContain(state);
    });

  it.each(['invalid_grant', 'timeout', 'untrusted'] as const)(
    'classifies attempted silent renewal %s while preserving fail-closed token outcome', async failure => {
      const f = await mcpPortalFixture(); f.expiry(30); await f.begin(); await f.finish();
      const send: typeof fetch = async () => {
        if (failure === 'timeout') throw new DOMException(secret, 'TimeoutError');
        if (failure === 'untrusted') throw { errorCode: secret, message: secret, body: { refresh_token: refresh } };
        return Response.json({ error: failure, error_description: secret }, { status: 400 });
      };
      const records = await capture(async () => {
        expect(await getValidMcpPortalToken(f.env, 'owner', portal, send)).toBeNull();
      });
      expect(records).toEqual([{ operation: 'renewal', stage: 'refresh', outcome: 'rejected',
        detail: failure === 'untrusted' ? 'other' : failure }]);
    });

  it('records observed same-generation renewal reuse without replaying provider effects', async () => {
    const f = await mcpPortalFixture(); f.expiry(30); await f.begin(); await f.finish();
    const old = await f.connectionSnapshot(); f.expiry(3600); f.rotateRefresh();
    expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBe(`${access}-ROTATED`);
    const winner = await f.connectionSnapshot(); f.readConnection(old);
    const records = await capture(async () => {
      expect(await getValidMcpPortalToken(f.env, 'owner', portal, async (input, init) => {
        const response = await f.send(input, init); f.readConnection(winner); return response;
      })).toBe(`${access}-ROTATED`);
    });
    expect(records).toEqual([{ operation: 'renewal', stage: 'winner-lookup', outcome: 'reused-current' }]);
  });

  it('keeps absent-grant polling quiet and logger failures cannot replace original OAuth results or errors', async () => {
    const f = await mcpPortalFixture();
    expect(await capture(async () => {
      expect(await getMcpPortalGrant(f.env, 'owner', portal)).toBeNull();
      expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBeNull();
    })).toEqual([]);
    setLogLevel('info');
    const spies = (['log', 'warn', 'error'] as const).map(level => vi.spyOn(console, level)
      .mockImplementation(() => { throw Error('synthetic logger unavailable'); }));
    try {
      f.expiry(30); await f.begin(); await f.finish(); f.expiry(3600);
      expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBe(`${access}-ROTATED`);
      const thrown = new Error(secret);
      const send: typeof fetch = async (input, init) => {
        if (path(input) === '/register') throw thrown;
        return f.send(input, init);
      };
      await expect(beginMcpPortalConnect(f.env, 'owner', portal, instance, send)).rejects.toBe(thrown);
      await f.begin();
      const failedExchange: typeof fetch = async () => { throw thrown; };
      await expect(finishMcpPortalConnect(f.env, 'owner', instance, f.authorization.searchParams.get('state')!,
        'synthetic-code', undefined, failedExchange)).rejects.toBe(thrown);
      expect((await getMcpPortalGrant(f.env, 'owner', portal))?.tokens.access_token).toBe(`${access}-ROTATED`);
    } finally { spies.forEach(spy => spy.mockRestore()); setLogLevel('silent'); }
  });
});
