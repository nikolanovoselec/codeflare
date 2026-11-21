import { describe, expect, it, vi } from 'vitest';
import { mcpPortalFixture, portal, instance, access, refresh, deferred, legacyCiphertext, legacyConnectionKey } from '../helpers/mcp-portal-fixture';
import { beginMcpPortalConnect, finishMcpPortalConnect, getMcpPortalGrant, getValidMcpPortalToken, disconnectMcpPortal,
  portalOAuthFetch, publicHttps } from '../../lib/mcp-portal-token';
import { SETUP_KEYS } from '../../lib/kv-keys';
import { decryptFromKV, getOrImportKey, encryptForKV } from '../../lib/kv-crypto';
import { setLogLevel } from '../../lib/logger';

async function legacyFixture(lifetime = 3600) {
  const source = await mcpPortalFixture(); source.expiry(lifetime); await source.begin(); await source.finish();
  const grant = (await getMcpPortalGrant(source.env, 'owner', portal))!;
  const f = await mcpPortalFixture();
  await f.kv.put(legacyConnectionKey(), await legacyCiphertext(f.env, grant));
  return f;
}

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
    const stored = await f.connectionSnapshot();
    expect(stored.startsWith('v1:')).toBe(true);
    expect(stored).not.toContain(access); expect(stored).not.toContain(refresh);
    // New authorizations no longer publish credentials into eventually consistent KV.
    expect((await f.kv.list({ prefix: 'mcp-portal:owner:' })).keys).toHaveLength(0);
    expect(await getMcpPortalGrant(f.env, 'other-owner', portal)).toBeNull();
    expect(await getMcpPortalGrant(f.env, 'owner', { ...portal, url: 'https://other.example/mcp' })).toBeNull();
  });

  it('REQ-AGENT-226 AC1/5: opaque provider tokens survive encrypted publication and silent renewal unchanged', async () => {
    const f = await mcpPortalFixture(); f.expiry(30);
    const issued = 'synthetic-user@example.test:synthetic-grant:opaque+/=';
    const renewed = 'synthetic-user@example.test:synthetic-grant:renewed+/=';
    const send: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const body = new URLSearchParams(await request.clone().text());
      const response = await f.send(request);
      const tokens = await response.json() as Record<string, unknown>;
      return Response.json({ ...tokens, access_token: body.get('grant_type') === 'refresh_token' ? renewed : issued });
    };
    const authorization = await f.begin();
    await finishMcpPortalConnect(f.env, 'owner', instance, authorization.searchParams.get('state')!, 'synthetic-code', undefined, send);
    expect((await getMcpPortalGrant(f.env, 'owner', portal))?.tokens.access_token).toBe(issued);
    const stored = await f.connectionSnapshot();
    expect(stored.startsWith('v1:')).toBe(true);
    expect(stored).not.toContain(issued);
    f.expiry(3600);
    expect(await getValidMcpPortalToken(f.env, 'owner', portal, send)).toBe(renewed);
    expect((await getMcpPortalGrant(f.env, 'owner', portal))?.tokens.access_token).toBe(renewed);
    expect(await getMcpPortalGrant(f.env, 'other-owner', portal)).toBeNull();
  });

  it.each([
    { access_token: '' }, { access_token: 'not a bearer' }, { access_token: 'token\tvalue' },
    { access_token: 'token\n' }, { access_token: 'token\r' },
    { access_token: ' token' }, { access_token: 'token ' },
    { access_token: 'token\r\nInjected: header' }, { access_token: 'token\u0000value' },
    { access_token: 'token\u007fvalue' }, { access_token: 'token\u0080value' },
    { access_token: 'token\u2028value' }, { token_type: 'Basic' },
    { expires_in: 0 }, { expires_in: -1 }, { expires_in: 'Infinity' }, { expires_in: 'NaN' },
  ])('REQ-AGENT-226 AC1/2: unsafe or invalid token response %# cannot publish an owner grant', async override => {
    const f = await mcpPortalFixture(); await f.begin();
    const send: typeof fetch = async (input, init) => {
      const response = await f.send(input, init);
      return Response.json({ ...await response.json() as object, ...override });
    };
    await expect(finishMcpPortalConnect(f.env, 'owner', instance, f.authorization.searchParams.get('state')!,
      'synthetic-code', undefined, send)).rejects.toThrow();
    expect(await getMcpPortalGrant(f.env, 'owner', portal)).toBeNull();
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
    if (timing === 'during-discovery') {
      f.beforeDiscovery(() => disconnectMcpPortal(f.env, 'owner', portal, f.send));
      await expect(f.begin()).rejects.toThrow(/connection changed/);
    } else {
      await f.begin();
      await disconnectMcpPortal(f.env, 'owner', portal, f.send);
      await expect(f.finish()).rejects.toThrow(/connection changed/);
    }
    expect(f.issuedForCode('synthetic-code')).toBeUndefined();
    expect(await getMcpPortalGrant(f.env, 'owner', portal)).toBeNull();
  });

  it('REQ-AGENT-226 AC4: encryption is mandatory and ciphertext cannot move between owner records', async () => {
    const f = await legacyFixture();
    await expect(beginMcpPortalConnect({ ...f.env, ENCRYPTION_KEY: undefined }, 'owner', portal, instance, f.send)).rejects.toThrow(/encryption/);
    const key = (await f.kv.list({ prefix: 'mcp-portal:owner:' })).keys[0]!.name;
    const ciphertext = await f.kv.get(key);
    if (typeof ciphertext !== 'string') throw new Error('Encrypted KV record must be a string');
    await f.kv.put(key.replace(':owner:owner:', ':owner:other:'), ciphertext);
    expect(await getMcpPortalGrant(f.env, 'other', portal)).toBeNull();
    await f.kv.put(key, JSON.stringify({ grant: { tokens: { access_token: access } } }));
    expect(await getMcpPortalGrant(f.env, 'owner', portal)).toBeNull();
  });

  it('REQ-AGENT-226 AC4: grant lookup uses one ciphertext snapshot, never a later plaintext substitute', async () => {
    const f = await legacyFixture();
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
      const f = await legacyFixture();
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

  it('REQ-AGENT-226 AC5: a delayed successful refresh reuses only the committed same-lineage winner', async () => {
    const f = await mcpPortalFixture(); f.expiry(30); await f.begin(); await f.finish(); f.expiry(3600);
    const arrived = deferred(); const release = deferred();
    const delayed: typeof fetch = async (input, init) => {
      const response = await f.send(input, init); arrived.resolve(); await release.promise; return response;
    };
    const loser = getValidMcpPortalToken(f.env, 'owner', portal, delayed);
    await arrived.promise;
    try { expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBe(`${access}-ROTATED`); }
    finally { release.resolve(); }
    expect(await loser).toBe(`${access}-ROTATED`);
    expect((await getMcpPortalGrant(f.env, 'owner', portal))?.tokens.access_token).toBe(`${access}-ROTATED`);
  });

  it('REQ-AGENT-226 AC5: permanently stale legacy ciphertext cannot roll back an authoritative refresh', async () => {
    const f = await legacyFixture(30);
    const old = await f.kv.get(legacyConnectionKey()) as string;
    expect((await getMcpPortalGrant(f.env, 'owner', portal))?.tokens.access_token).toBe(access);
    f.readConnection(old); f.expiry(3600); f.rotateRefresh();
    expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBe(`${access}-ROTATED`);
    expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBe(`${access}-ROTATED`);
  });

  it('REQ-AGENT-226 AC4/7: a delayed legacy read cannot overwrite or bypass Disconnect', async () => {
    const f = await legacyFixture();
    const key = legacyConnectionKey();
    const encrypted = await f.kv.get(key);
    const read = f.kv.get.getMockImplementation()!;
    const reached = deferred(); const release = deferred();
    let held = false;
    f.kv.get.mockImplementation(async (name, type) => {
      if (name === key && !held) { held = true; reached.resolve(); await release.promise; return encrypted; }
      return read(name, type);
    });
    const pendingRead = getMcpPortalGrant(f.env, 'owner', portal);
    await reached.promise;
    try { await disconnectMcpPortal(f.env, 'owner', portal, f.send); }
    finally { release.resolve(); }
    expect(await pendingRead).toBeNull();
    expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBeNull();
  });

  it('REQ-AGENT-226 AC6: Disconnect wins while a completed provider refresh is waiting to publish', async () => {
    const f = await mcpPortalFixture(); f.expiry(30); await f.begin(); await f.finish(); f.expiry(3600);
    const send: typeof fetch = async (input, init) => {
      const response = await f.send(input, init);
      await disconnectMcpPortal(f.env, 'owner', portal, f.send);
      return response;
    };
    expect(await getValidMcpPortalToken(f.env, 'owner', portal, send)).toBeNull();
    expect(await getMcpPortalGrant(f.env, 'owner', portal)).toBeNull();
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

  it('REQ-AGENT-226 AC6: an expired committed winner is unusable by a delayed refresh', async () => {
    const f = await mcpPortalFixture(); f.expiry(30); await f.begin(); await f.finish();
    const reached = deferred(); const release = deferred();
    const loser = getValidMcpPortalToken(f.env, 'owner', portal, async (input, init) => {
      const response = await f.send(input, init); reached.resolve(); await release.promise; return response;
    });
    await reached.promise;
    try {
      expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBe(`${access}-ROTATED`);
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
      try { release.resolve(); expect(await loser).toBeNull(); }
      finally { clock.mockRestore(); }
    } finally { release.resolve(); }
  });

  it('REQ-AGENT-226 AC6: rotating refresh rejection before winner publication never falls back to the old token', async () => {
    const f = await mcpPortalFixture(); f.expiry(30); await f.begin(); await f.finish(); f.rotateRefresh(); f.expiry(3600);
    const reached = deferred(); const release = deferred();
    const winner = getValidMcpPortalToken(f.env, 'owner', portal, async (input, init) => {
      const response = await f.send(input, init); reached.resolve(); await release.promise; return response;
    });
    await reached.promise;
    try { expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBeNull(); }
    finally { release.resolve(); }
    expect(await winner).toBe(`${access}-ROTATED`);
    expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBe(`${access}-ROTATED`);
  });

  it.each(['callback', 'refresh'] as const)(
    'REQ-AGENT-226 AC2/5/7: Disconnect between the final %s observation and commit cannot be overwritten', async operation => {
      const f = await mcpPortalFixture(); f.expiry(operation === 'refresh' ? 30 : 3600);
      await f.begin(); await f.finish();
      if (operation === 'callback') await f.begin();
      f.expiry(3600);
      f.beforeConnectionWrite(() => disconnectMcpPortal(f.env, 'owner', portal, f.send));
      if (operation === 'callback') await expect(f.finish()).rejects.toThrow();
      else expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBeNull();
      expect(await getMcpPortalGrant(f.env, 'owner', portal)).toBeNull();
      f.owners.reconstruct('owner');
      expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBeNull();
    });

  it('REQ-AGENT-226 AC7: disconnect affects only selected owner/portal and never restores failed revocation', async () => {
    const f = await mcpPortalFixture(); await f.begin(); await f.finish(); await f.begin('other'); await f.finish('other');
    const secondPortal = { ...portal, name: 'second' };
    await f.kv.put(SETUP_KEYS.MCP_PORTALS, JSON.stringify([portal, secondPortal]));
    f.visitAuthorization(await beginMcpPortalConnect(f.env, 'owner', secondPortal, instance, f.send));
    await f.finish();
    await f.kv.put('deploy-keys:owner', 'unrelated-GitHub-Cloudflare-state');
    const unavailable: typeof fetch = async () => { throw Error('revocation unavailable'); };
    await disconnectMcpPortal(f.env, 'owner', portal, unavailable);
    expect(await getMcpPortalGrant(f.env, 'owner', portal)).toBeNull();
    expect(await getValidMcpPortalToken(f.env, 'other', portal, f.send)).toBe(access);
    expect(await getValidMcpPortalToken(f.env, 'owner', secondPortal, f.send)).toBe(access);
    expect(await f.kv.get('deploy-keys:owner')).toBe('unrelated-GitHub-Cloudflare-state');
  });

  it('REQ-AGENT-226 AC7: Disconnect before legacy import revokes the original grant and erases only its exact KV key', async () => {
    const f = await legacyFixture();
    const key = legacyConnectionKey();
    const legacy = await f.kv.get(key) as string;
    await f.begin('other'); await f.finish('other');
    const neighborKey = legacyConnectionKey('other');
    const neighbor = await legacyCiphertext(f.env, (await getMcpPortalGrant(f.env, 'other', portal))!);
    await f.kv.put(neighborKey, neighbor);
    expect(await f.owners.owner('owner').mcpPortalRead('owner', portal.name))
      .toMatchObject({ ciphertext: null, legacyImportEligible: true });
    // Replica readback stays stale even after the underlying KV deletion succeeds.
    f.readConnection(legacy);
    const revocations: Array<{ url: string; method: string; body: Record<string, string>; redirect: RequestRedirect }> = [];
    const visibleDuringRevocation: Array<string | null> = [];
    await disconnectMcpPortal(f.env, 'owner', portal, async (input, init) => {
      const request = new Request(input, init);
      revocations.push({ url: request.url, method: request.method, redirect: request.redirect,
        body: Object.fromEntries(new URLSearchParams(await request.text())) });
      visibleDuringRevocation.push(await getValidMcpPortalToken(f.env, 'owner', portal, f.send));
      return new Response(null, { status: 200 });
    });
    // Intentional OAuth revocation wire contract, not an internal helper call count.
    expect(revocations).toEqual([{ url: 'https://portal.example/revoke', method: 'POST', redirect: 'manual',
      body: { token: refresh, client_id: 'synthetic-client', token_type_hint: 'refresh_token' } }]);
    expect(visibleDuringRevocation).toEqual([null]);
    expect(f.kv._store.has(key)).toBe(false);
    expect(await f.kv.get(neighborKey)).toBe(neighbor);
    f.owners.reconstruct('owner');
    expect(await getMcpPortalGrant(f.env, 'owner', portal)).toBeNull();
    expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBeNull();
    expect(await getValidMcpPortalToken(f.env, 'other', portal, f.send)).toBe(access);
  });

  it.each(['wrong-key', 'invalid-key', 'revocation'] as const)(
    'REQ-AGENT-226 AC4/7: legacy Disconnect still erases credentials after %s failure', async failure => {
      const f = await legacyFixture();
      const key = legacyConnectionKey();
      const legacy = await f.kv.get(key) as string;
      const encryptionKey = f.env.ENCRYPTION_KEY;
      const neighborKey = legacyConnectionKey('other');
      await f.kv.put(neighborKey, 'unrelated-neighbor-ciphertext');
      expect(await f.owners.owner('owner').mcpPortalRead('owner', portal.name))
        .toMatchObject({ ciphertext: null, legacyImportEligible: true });
      if (failure === 'wrong-key') f.env.ENCRYPTION_KEY = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
      if (failure === 'invalid-key') f.env.ENCRYPTION_KEY = 'invalid-encryption-key';
      const revokedTokens: Array<string | null> = [];
      const result = await disconnectMcpPortal(f.env, 'owner', portal, async (input, init) => {
        const request = new Request(input, init);
        revokedTokens.push(new URLSearchParams(await request.text()).get('token'));
        throw new Error('synthetic revocation unavailable');
      }).then(() => ({ status: 'fulfilled' as const }), error => ({ status: 'rejected' as const, error }));
      // An unusable encryption key may surface an error, but may never bypass erasure.
      if (failure !== 'invalid-key') expect(result.status).toBe('fulfilled');
      expect(revokedTokens).toEqual(failure === 'revocation' ? [refresh] : []);
      expect(f.kv._store.has(key)).toBe(false);
      expect(await f.kv.get(neighborKey)).toBe('unrelated-neighbor-ciphertext');
      f.env.ENCRYPTION_KEY = encryptionKey;
      f.readConnection(legacy);
      f.owners.reconstruct('owner');
      expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBeNull();
    });

  it('REQ-AGENT-226 AC7: failed legacy KV erasure rejects Disconnect without reopening the local grant', async () => {
    const f = await legacyFixture();
    const key = legacyConnectionKey();
    const legacy = await f.kv.get(key) as string;
    const remove = f.kv.delete.getMockImplementation()!;
    f.kv.delete.mockImplementation(async name => {
      if (name === key) throw new Error('synthetic legacy deletion unavailable');
      return remove(name);
    });
    await expect(disconnectMcpPortal(f.env, 'owner', portal, f.send)).rejects.toThrow();
    expect(f.kv._store.get(key)).toBe(legacy);
    f.readConnection(legacy);
    f.owners.reconstruct('owner');
    expect(await f.owners.owner('owner').mcpPortalRead('owner', portal.name))
      .toMatchObject({ ciphertext: null, legacyImportEligible: false });
    expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBeNull();
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
  it.each(['tombstone', 'generation', 'configuration', 'other-owner'] as const)(
    'REQ-AGENT-226 AC6 / REQ-AGENT-228 AC4: expected recovery generation rejects %s before provider I/O', async change => {
      const f = await mcpPortalFixture(); await f.begin(); await f.finish();
      const original = (await getMcpPortalGrant(f.env, 'owner', portal))!;
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
      if (failure === 'publication') f.failPublication(new Error(secret));
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
    const f = await mcpPortalFixture(); f.expiry(30); await f.begin(); await f.finish(); f.expiry(3600);
    const records = await capture(async () => {
      expect(await getValidMcpPortalToken(f.env, 'owner', portal, async (input, init) => {
        const response = await f.send(input, init);
        expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBe(`${access}-ROTATED`);
        return response;
      })).toBe(`${access}-ROTATED`);
    });
    expect(records).toEqual([
      { operation: 'renewal', stage: 'readback', outcome: 'completed' },
      { operation: 'renewal', stage: 'publication-check', outcome: 'reused-current' },
    ]);
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

// These are owner-wire tests, not a mock state machine. The same production
// class and native DurableObjectStorage are used by all public-flow tests above.
// Until the approved RPCs exist, a missing-RPC setup error is NOT behavioral RED.
describe('Atomic owner MCP state and durable offboarding', () => {
  async function wireFixture() {
    const f = await mcpPortalFixture();
    const owner = f.owners.owner('owner');
    const payload = await encryptForKV('synthetic-owner-wire-payload', (await getOrImportKey(f.env))!, 'fixture-wire');
    return { ...f, owner, payload };
  }

  it('REQ-AGENT-226 AC4: an empty unoffboarded owner imports legacy once and never uses it to overwrite a newer revision', async () => {
    const f = await wireFixture();
    const empty = await f.owner.mcpPortalRead('owner', portal.name);
    expect(empty).toMatchObject({ ciphertext: null, legacyImportEligible: true, fence: { revision: 0 } });
    const imported = await f.owner.mcpPortalImport('owner', portal.name, empty.fence, f.payload);
    expect(imported).toMatchObject({ ciphertext: f.payload, legacyImportEligible: false });
    expect(imported?.fence.revision).toBe(empty.fence.revision + 1);
    expect(await f.owner.mcpPortalImport('owner', portal.name, empty.fence, f.payload)).toBeNull();
    expect(await f.owner.mcpPortalRead('owner', portal.name)).toEqual(imported);
  });

  it('REQ-AGENT-226 AC2/7: concurrent publication and Disconnect cannot leave a resurrected grant', async () => {
    const f = await wireFixture();
    const original = await f.owner.mcpPortalRead('owner', portal.name);
    const [published, disconnected] = await Promise.all([
      f.owner.mcpPortalPublish('owner', portal.name, original.fence, f.payload),
      f.owner.mcpPortalDisconnect('owner', portal.name),
    ]);
    const current = await f.owner.mcpPortalRead('owner', portal.name);
    expect(current.ciphertext).toBeNull();
    expect(current.legacyImportEligible).toBe(false);
    expect(current.fence.revision).toBeGreaterThan(original.fence.revision);
    expect(disconnected.current.ciphertext).toBeNull();
    if (published) expect(disconnected.previous.ciphertext).toBe(published.ciphertext);
    expect(await f.owner.mcpPortalImport('owner', portal.name, original.fence, f.payload)).toBeNull();
    expect(await f.owner.mcpPortalPublish('owner', portal.name, original.fence, f.payload)).toBeNull();
  });

  it('REQ-AGENT-226 AC5: two writers holding one fence have exactly one committed ciphertext winner', async () => {
    const f = await wireFixture();
    const original = await f.owner.mcpPortalRead('owner', portal.name);
    const second = await encryptForKV('second-wire-payload', (await getOrImportKey(f.env))!, 'fixture-wire');
    const results = await Promise.all([
      f.owner.mcpPortalPublish('owner', portal.name, original.fence, f.payload),
      f.owner.mcpPortalPublish('owner', portal.name, original.fence, second),
    ]);
    const winners = results.filter(result => result !== null);
    expect(winners).toHaveLength(1);
    const current = await f.owner.mcpPortalRead('owner', portal.name);
    expect(current).toEqual(winners[0]);
    expect(current.fence.revision).toBe(original.fence.revision + 1);
    expect([f.payload, second]).toContain(current.ciphertext);
  });

  it('REQ-AGENT-226 AC2: pending consumption is one-use and checks expiry and the portal fence transactionally', async () => {
    const f = await wireFixture();
    const snapshot = await f.owner.mcpPortalRead('owner', portal.name);
    const pending = { state: 'a'.repeat(64), portalName: portal.name, expected: snapshot.fence,
      expiresAt: Date.now() + 300_000, ciphertext: f.payload };
    expect(await f.owner.mcpPortalSavePending('owner', pending)).toBe(true);
    const consumed = await Promise.all([
      f.owner.mcpPortalConsumePending('owner', pending.state), f.owner.mcpPortalConsumePending('owner', pending.state),
    ]);
    expect(consumed.filter(Boolean)).toEqual([{ portalName: portal.name, fence: snapshot.fence, ciphertext: f.payload }]);
    expect(await f.owner.mcpPortalSavePending('owner', { ...pending, state: 'b'.repeat(64) })).toBe(true);
    await f.owner.mcpPortalDisconnect('owner', portal.name);
    expect(await f.owner.mcpPortalConsumePending('owner', 'b'.repeat(64))).toBeNull();
    expect(await f.owner.mcpPortalSavePending('owner', { ...pending, state: 'c'.repeat(64) })).toBe(false);
    const fresh = await f.owner.mcpPortalRead('owner', portal.name);
    expect(await f.owner.mcpPortalSavePending('owner', { ...pending, state: 'd'.repeat(64), expected: fresh.fence })).toBe(true);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(pending.expiresAt + 1);
    try { expect(await f.owner.mcpPortalConsumePending('owner', 'd'.repeat(64))).toBeNull(); }
    finally { clock.mockRestore(); }
  });

  it('REQ-AGENT-226 AC1/2: each owner admits at most 128 pending authorizations without evicting admitted states', async () => {
    const f = await wireFixture();
    const snapshot = await f.owner.mcpPortalRead('owner', portal.name);
    const pending = { portalName: portal.name, expected: snapshot.fence,
      expiresAt: Date.now() + 300_000, ciphertext: f.payload };
    const secondPortal = await f.owner.mcpPortalRead('owner', 'second');
    const states = Array.from({ length: 128 }, (_, index) => ({
      state: (index + 1).toString(16).padStart(64, '0'),
      portalName: index % 2 === 0 ? portal.name : 'second',
      expected: index % 2 === 0 ? snapshot.fence : secondPortal.fence,
    }));
    const admitted: boolean[] = [];
    for (const state of states) admitted.push(await f.owner.mcpPortalSavePending('owner', { ...pending, ...state }));
    expect(admitted).toEqual(Array(128).fill(true));
    const overflow = 'f'.repeat(64);
    const overflowPayload = await encryptForKV('overflow-pending-payload', (await getOrImportKey(f.env))!, 'fixture-wire');
    expect(await f.owner.mcpPortalSavePending('owner', { ...pending, state: overflow, ciphertext: overflowPayload })).toBe(false);
    f.owners.reconstruct('owner');
    expect(await f.owner.mcpPortalSavePending('owner', { ...pending, state: overflow, ciphertext: overflowPayload })).toBe(false);
    const retained = JSON.stringify([...(await f.owners.storage('owner', storage => storage.list()))]);
    expect(retained).not.toContain(overflowPayload);
    const other = f.owners.owner('other');
    const otherSnapshot = await other.mcpPortalRead('other', portal.name);
    expect(await other.mcpPortalSavePending('other', { ...pending, expected: otherSnapshot.fence, state: overflow })).toBe(true);
    expect(await other.mcpPortalConsumePending('other', overflow))
      .toEqual({ portalName: portal.name, fence: otherSnapshot.fence, ciphertext: f.payload });
    for (const state of states) {
      expect(await f.owner.mcpPortalConsumePending('owner', state.state))
        .toEqual({ portalName: state.portalName, fence: state.expected, ciphertext: f.payload });
    }
    expect(await f.owner.mcpPortalConsumePending('owner', overflow)).toBeNull();
    expect(await f.owner.mcpPortalSavePending('owner', { ...pending, state: overflow, ciphertext: overflowPayload })).toBe(true);
    expect(await f.owner.mcpPortalConsumePending('owner', overflow))
      .toEqual({ portalName: portal.name, fence: snapshot.fence, ciphertext: overflowPayload });
  });

  it.each(['save', 'consume'] as const)(
    'REQ-AGENT-226 AC1/2/4: the next pending %s erases all expired ciphertext while preserving live authorizations', async operation => {
      const f = await wireFixture();
      const snapshot = await f.owner.mcpPortalRead('owner', portal.name);
      const initialAlarm = await f.owners.storage('owner', storage => storage.getAlarm());
      const now = Date.now();
      const key = (await getOrImportKey(f.env))!;
      const expired = await Promise.all(['first-expired-pending', 'second-expired-pending']
        .map(value => encryptForKV(value, key, 'fixture-wire')));
      const live = await encryptForKV('live-pending-payload', key, 'fixture-wire');
      const input = { portalName: portal.name, expected: snapshot.fence, expiresAt: now + 60_000 };
      for (const [index, ciphertext] of expired.entries()) {
        expect(await f.owner.mcpPortalSavePending('owner', { ...input,
          state: String(index + 1).repeat(64), ciphertext })).toBe(true);
      }
      const liveState = '3'.repeat(64);
      expect(await f.owner.mcpPortalSavePending('owner', { ...input, state: liveState,
        expiresAt: now + 300_000, ciphertext: live })).toBe(true);
      const before = JSON.stringify([...(await f.owners.storage('owner', storage => storage.list()))]);
      for (const ciphertext of expired) expect(before).toContain(ciphertext);
      expect(before).toContain(live);
      expect(await f.owners.storage('owner', storage => storage.getAlarm())).toBe(initialAlarm);
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 60_001);
      try {
        const freshState = '4'.repeat(64);
        if (operation === 'save') {
          expect(await f.owner.mcpPortalSavePending('owner', { ...input, state: freshState,
            expiresAt: Date.now() + 300_000, ciphertext: f.payload })).toBe(true);
        } else {
          // Even an unknown nonce is a pending operation, not an expiry alarm.
          expect(await f.owner.mcpPortalConsumePending('owner', freshState)).toBeNull();
        }
        const after = JSON.stringify([...(await f.owners.storage('owner', storage => storage.list()))]);
        for (const ciphertext of expired) expect(after).not.toContain(ciphertext);
        expect(after).toContain(live);
        expect(await f.owners.storage('owner', storage => storage.getAlarm())).toBe(initialAlarm);
        for (const state of ['1'.repeat(64), '2'.repeat(64)]) {
          expect(await f.owner.mcpPortalConsumePending('owner', state)).toBeNull();
        }
        expect(await f.owner.mcpPortalConsumePending('owner', liveState))
          .toEqual({ portalName: portal.name, fence: snapshot.fence, ciphertext: live });
        if (operation === 'save') {
          expect(await f.owner.mcpPortalConsumePending('owner', freshState))
            .toEqual({ portalName: portal.name, fence: snapshot.fence, ciphertext: f.payload });
        }
      } finally { clock.mockRestore(); }
    });

  it('REQ-AUTH-026 AC2 / REQ-AGENT-226 AC2: stale completion after reconstruction cannot reopen a newer offboarding operation', async () => {
    const f = await wireFixture();
    const old = await f.owner.mcpPortalRead('owner', portal.name);
    const first = await f.owner.mcpPortalBeginOffboarding('owner', 'owner@example.com');
    f.owners.reconstruct('owner');
    await expect(f.owner.mcpPortalRead('owner', portal.name)).rejects.toThrow();
    const second = await f.owner.mcpPortalBeginOffboarding('owner', 'owner@example.com');
    expect(second.operationId).not.toBe(first.operationId);
    expect(await f.owner.mcpPortalCompleteOffboarding('owner', first.operationId)).toBe(false);
    await expect(f.owner.mcpPortalRead('owner', portal.name)).rejects.toThrow();
    expect(await f.owner.mcpPortalCompleteOffboarding('owner', second.operationId)).toBe(true);
    const reopened = await f.owner.mcpPortalRead('owner', portal.name);
    expect(reopened.ciphertext).toBeNull();
    expect(reopened.fence.epoch).not.toBe(old.fence.epoch);
    expect(reopened.legacyImportEligible).toBe(false);
    expect(await f.owner.mcpPortalImport('owner', portal.name, reopened.fence, f.payload)).toBeNull();
    expect(await f.owner.mcpPortalPublish('owner', portal.name, old.fence, f.payload)).toBeNull();
    expect(await f.owner.mcpPortalPublish('owner', portal.name, reopened.fence, f.payload)).toMatchObject({ ciphertext: f.payload });
  });

  it('REQ-AUTH-026 AC2 / REQ-AGENT-226 AC2/4: offboarding purges pending authorizations and all portal grants without clearing another owner', async () => {
    const f = await wireFixture();
    const a = await f.owner.mcpPortalRead('owner', portal.name);
    const b = await f.owner.mcpPortalRead('owner', 'removed');
    await f.owner.mcpPortalPublish('owner', portal.name, a.fence, f.payload);
    await f.owner.mcpPortalPublish('owner', 'removed', b.fence, f.payload);
    const current = await f.owner.mcpPortalRead('owner', portal.name);
    await f.owner.mcpPortalSavePending('owner', { state: 'a'.repeat(64), portalName: portal.name,
      expected: current.fence, expiresAt: Date.now() + 300_000, ciphertext: f.payload });
    const other = f.owners.owner('other');
    const otherBefore = await other.mcpPortalRead('other', portal.name);
    const otherGrant = await other.mcpPortalPublish('other', portal.name, otherBefore.fence, f.payload);
    const operation = await f.owner.mcpPortalBeginOffboarding('owner', 'owner@example.com');
    expect(await f.owner.mcpPortalCompleteOffboarding('owner', operation.operationId)).toBe(true);
    expect(await f.owner.mcpPortalConsumePending('owner', 'a'.repeat(64))).toBeNull();
    for (const name of [portal.name, 'removed']) {
      expect(await f.owner.mcpPortalRead('owner', name)).toMatchObject({ ciphertext: null, legacyImportEligible: false });
    }
    expect(await other.mcpPortalRead('other', portal.name)).toEqual(otherGrant);
  });

  it('REQ-AGENT-226 AC1/4: pending verifier and published provider credentials are encrypted in native owner storage', async () => {
    const f = await mcpPortalFixture();
    await f.begin();
    const pending = JSON.stringify([...(await f.owners.storage('owner', storage => storage.list()))]);
    let verifier = '';
    await finishMcpPortalConnect(f.env, 'owner', instance, f.authorization.searchParams.get('state')!,
      'synthetic-code', undefined, async (input, init) => {
        const request = new Request(input, init);
        verifier = new URLSearchParams(await request.clone().text()).get('code_verifier')!;
        return f.send(request);
      });
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    const published = JSON.stringify([...(await f.owners.storage('owner', storage => storage.list()))]);
    for (const secret of [verifier, access, refresh, 'synthetic-code']) {
      expect(pending).not.toContain(secret);
      expect(published).not.toContain(secret);
    }
    expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBe(access);
    expect((await f.owners.owner('owner').mcpPortalRead('owner', portal.name)).ciphertext?.startsWith('v1:')).toBe(true);
  });

  it('REQ-AGENT-226 AC4: ciphertext cannot move to a different portal or pending record kind', async () => {
    const f = await mcpPortalFixture(); await f.begin(); await f.finish();
    const owner = f.owners.owner('owner');
    const original = await owner.mcpPortalRead('owner', portal.name);
    const alternate = { ...portal, name: 'alternate' };
    await f.kv.put(SETUP_KEYS.MCP_PORTALS, JSON.stringify([portal, alternate]));
    const target = await owner.mcpPortalRead('owner', alternate.name);
    await owner.mcpPortalPublish('owner', alternate.name, target.fence, original.ciphertext!);
    expect(await getMcpPortalGrant(f.env, 'owner', alternate)).toBeNull();
    const state = 'e'.repeat(64);
    await owner.mcpPortalSavePending('owner', { state, portalName: portal.name, expected: original.fence,
      expiresAt: Date.now() + 300_000, ciphertext: original.ciphertext! });
    let exchanged = false;
    await expect(finishMcpPortalConnect(f.env, 'owner', instance, state, 'synthetic-code', undefined, async () => {
      exchanged = true; return Response.json({ access_token: 'must-not-publish', token_type: 'Bearer' });
    })).rejects.toThrow();
    expect(exchanged).toBe(false);
    expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBe(access);
  });

  it('REQ-AGENT-226 AC4: owner and epoch context changes cannot turn moved ciphertext into a token', async () => {
    const f = await mcpPortalFixture(); await f.begin(); await f.finish();
    const owner = f.owners.owner('owner');
    const original = await owner.mcpPortalRead('owner', portal.name);
    const other = f.owners.owner('other');
    const target = await other.mcpPortalRead('other', portal.name);
    await other.mcpPortalPublish('other', portal.name, target.fence, original.ciphertext!);
    expect(await getMcpPortalGrant(f.env, 'other', portal)).toBeNull();
    const operation = await owner.mcpPortalBeginOffboarding('owner', 'owner@example.com');
    await owner.mcpPortalCompleteOffboarding('owner', operation.operationId);
    const reopened = await owner.mcpPortalRead('owner', portal.name);
    await owner.mcpPortalPublish('owner', portal.name, reopened.fence, original.ciphertext!);
    expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBeNull();
  });

  it('REQ-AGENT-226 AC4: plaintext never becomes a usable authoritative grant and storage contains no OAuth secrets', async () => {
    const f = await mcpPortalFixture(); await f.begin(); await f.finish();
    const original = (await getMcpPortalGrant(f.env, 'owner', portal))!;
    const owner = f.owners.owner('owner');
    const snapshot = await owner.mcpPortalRead('owner', portal.name);
    const values = await f.owners.storage('owner', storage => storage.list());
    const serialized = JSON.stringify([...values]);
    for (const secret of [access, refresh, 'synthetic-code']) expect(serialized).not.toContain(secret);
    expect(snapshot.ciphertext?.startsWith('v1:')).toBe(true);
    await expect(owner.mcpPortalPublish('owner', portal.name, snapshot.fence,
      JSON.stringify({ id: original.id, grant: original }))).rejects.toThrow();
    expect(await owner.mcpPortalRead('owner', portal.name)).toEqual(snapshot);
    expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBe(access);
    const persisted = JSON.stringify([...(await f.owners.storage('owner', storage => storage.list()))]);
    expect(persisted).not.toContain(access); expect(persisted).not.toContain(refresh);
  });

  it('REQ-AGENT-226 AC2: legacy pending state without an authoritative fence cannot exchange a code', async () => {
    const source = await mcpPortalFixture(); await source.begin(); await source.finish();
    const grant = (await getMcpPortalGrant(source.env, 'owner', portal))!;
    const f = await mcpPortalFixture();
    const state = 'a'.repeat(64); const key = `mcp-portal:pending:${state}`;
    const { tokens: _tokens, ...binding } = grant;
    await f.kv.put(key, await encryptForKV(JSON.stringify({ ...binding, state, verifier: 'legacy-verifier',
      expiresAt: Date.now() + 300_000, previous: null }), (await getOrImportKey(f.env))!, key));
    let exchanged = false;
    await expect(finishMcpPortalConnect(f.env, 'owner', instance, state, 'synthetic-code', undefined, async () => {
      exchanged = true;
      return Response.json({ access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600 });
    })).rejects.toThrow();
    expect(exchanged).toBe(false);
    expect(await getMcpPortalGrant(f.env, 'owner', portal)).toBeNull();
  });

  it('REQ-AUTH-026 AC2 / REQ-AGENT-226 AC2: wrong owner identity or email cannot mutate the claimed owner', async () => {
    const f = await wireFixture();
    const before = await f.owner.mcpPortalRead('owner', portal.name);
    await expect(f.owner.mcpPortalRead('other', portal.name)).rejects.toThrow();
    await expect(f.owner.mcpPortalBeginOffboarding('owner', 'other@example.com')).rejects.toThrow();
    await expect(f.owners.owner('other').mcpPortalPublish('owner', portal.name, before.fence, f.payload)).rejects.toThrow();
    expect(await f.owner.mcpPortalRead('owner', portal.name)).toEqual(before);
  });
});
