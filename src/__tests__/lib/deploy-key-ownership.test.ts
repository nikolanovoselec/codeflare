import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import type { DeployKeys, Env } from '../../types';
import { connectGithub, disconnectGithub, getGithubConnectionStatus, getValidGithubToken } from '../../lib/github-token';
import { getCloudflareConnectionStatus, getValidCloudflareToken, storeCloudflareConnection } from '../../lib/cloudflare-token';
import deployKeysRoutes from '../../routes/deploy-keys';
import { SETUP_KEYS } from '../../lib/kv-keys';
import { attachMcpOwners, deferred } from '../helpers/mcp-portal-fixture';
import { createMockKV } from '../helpers/mock-kv';

vi.mock('../../lib/access', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/access')>(),
  authenticateRequest: async () => ({ user: { email: 'owner@example.com', authenticated: true, role: 'user' }, bucketName: 'owner' }),
}));

const bucket = 'owner';
const key = `deploy-keys:${bucket}`;

async function fixture(transport?: Parameters<typeof attachMcpOwners>[1]) {
  const kv = createMockKV();
  const original = {
    githubToken: 'old-app', githubTokenSource: 'app', githubRefreshToken: 'old-refresh',
    githubTokenExpiresAt: Date.now() - 1000, githubLogin: 'old-owner',
    cloudflareApiToken: 'original-cloudflare', cloudflareAccountId: 'original-account',
  } satisfies DeployKeys;
  kv._set(key, original);
  const env = { KV: kv, GITHUB_APP_CLIENT_ID: 'test-app', GITHUB_APP_CLIENT_SECRET: 'test-app-secret' } as unknown as Env;
  const owners = await attachMcpOwners(env, transport);
  await owners.claim(bucket, 'owner@example.com');
  const app = new Hono<{ Bindings: Env }>().route('/api/deploy-keys', deployKeysRoutes);
  const update = (patch: Partial<DeployKeys>) => app.request('/api/deploy-keys', { method: 'PUT',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }, env);
  const changePat = () => update({ githubToken: 'replacement-pat' });
  const reset = () => app.request('/api/deploy-keys', { method: 'DELETE' }, env);
  const staleLegacyRead = () => {
    const read = kv.get.getMockImplementation()!;
    kv.get.mockImplementation((name, type) => name !== key ? read(name, type)
      : Promise.resolve(type === 'json' ? original : JSON.stringify(original)));
  };
  return { env, kv, owners, update, changePat, reset, staleLegacyRead };
}

it.each(['disconnect', 'PAT replacement', 'reconnect', 'deploy keys reset', 'Cloudflare replacement'] as const)(
  'a pending GitHub refresh cannot undo %s even when legacy KV still returns its original grant', async action => {
    const { env, owners, changePat, reset, staleLegacyRead } = await fixture();
    const started = deferred();
    const finish = deferred();
    const requests = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/login/oauth/access_token') {
        const body = new URLSearchParams(String(init?.body));
        if (body.get('code') === 'reconnect') {
          // Deliberately reuse the refresh token: identity belongs to the save generation,
          // not the provider's opaque token bytes.
          return Response.json({ access_token: 'replacement-app', refresh_token: 'old-refresh', expires_in: 3600 });
        }
        expect(body.get('refresh_token')).toBe('old-refresh');
        started.resolve();
        await finish.promise;
        return Response.json({ access_token: 'obsolete-rotation', refresh_token: 'obsolete-refresh', expires_in: 3600 });
      }
      if (path === '/user') return Response.json({ login: 'replacement-owner' });
      if (path === '/applications/test-app/token') return new Response(null, { status: 204 });
      throw new Error(`Unexpected provider call: ${path}`);
    });
    const pending = getValidGithubToken(env, bucket);
    try {
      await Promise.race([started.promise, pending.then(() => { throw new Error('Refresh never reached GitHub'); })]);
      if (action === 'disconnect') await disconnectGithub(env, bucket);
      if (action === 'PAT replacement') expect((await changePat()).status).toBe(200);
      if (action === 'reconnect') await connectGithub(env, bucket, 'reconnect', 'https://example.com/callback');
      if (action === 'deploy keys reset') expect((await reset()).status).toBe(200);
      if (action === 'Cloudflare replacement') {
        await storeCloudflareConnection(env, bucket, { accessToken: 'replacement-cf', source: 'pat', accountId: 'replacement-account' });
      }
      staleLegacyRead();
      owners.reconstruct(bucket);
      finish.resolve();
      expect(await pending).toBe(action === 'Cloudflare replacement' ? 'obsolete-rotation' : null);
      const expected = action === 'PAT replacement' ? 'replacement-pat' : action === 'reconnect' ? 'replacement-app'
        : action === 'Cloudflare replacement' ? 'obsolete-rotation' : null;
      expect(await getValidGithubToken(env, bucket)).toBe(expected);
      expect(await getCloudflareConnectionStatus(env, bucket)).toMatchObject(action === 'deploy keys reset' ? { connected: false }
        : { connected: true, accountId: action === 'Cloudflare replacement' ? 'replacement-account' : 'original-account' });
    } finally {
      finish.resolve();
      await pending.catch(() => null);
      requests.mockRestore();
    }
  },
);

it('an ordinary Disconnect cannot erase a PAT replacement saved during provider revocation', async () => {
  const { env, changePat } = await fixture();
  const started = deferred();
  const finish = deferred();
  const requests = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const path = new URL(String(input)).pathname;
    if (path === '/user') return Response.json({ login: 'replacement-owner' });
    if (path === '/applications/test-app/token') {
      started.resolve();
      await finish.promise;
      return new Response(null, { status: 503 });
    }
    throw new Error(`Unexpected provider call: ${path}`);
  });
  const pending = disconnectGithub(env, bucket);
  try {
    await Promise.race([started.promise, pending.then(() => { throw new Error('Disconnect never reached GitHub'); })]);
    expect((await changePat()).status).toBe(200);
    finish.resolve();
    await pending;
    expect(await getGithubConnectionStatus(env, bucket)).toEqual({ connected: true, source: 'pat', login: undefined });
    expect(await getValidGithubToken(env, bucket)).toBe('replacement-pat');
  } finally {
    finish.resolve();
    await pending.catch(() => null);
    requests.mockRestore();
  }
});

it('Disconnect fences a committing renewal before revocation and leaves a later PAT intact', async () => {
  const committing = deferred();
  const commit = deferred();
  let suspendCommit = true;
  const { env, changePat } = await fixture({ async before(method) {
    if (method === 'compareOwnedDeployKeys' && suspendCommit) {
      suspendCommit = false;
      committing.resolve();
      await commit.promise;
    }
  } });
  const revoking = deferred();
  const revoke = deferred();
  const revoked: string[] = [];
  const requests = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/user') return Response.json({ login: 'replacement-owner' });
    if (path === '/login/oauth/access_token') {
      return Response.json({ access_token: 'obsolete-rotation', refresh_token: 'next', expires_in: 3600 });
    }
    if (path === '/applications/test-app/token') {
      revoked.push(JSON.parse(String(init?.body)).access_token);
      revoking.resolve();
      await revoke.promise;
      return new Response(null, { status: 503 });
    }
    throw new Error(`Unexpected provider call: ${path}`);
  });
  const refresh = getValidGithubToken(env, bucket);
  let disconnect: Promise<void> | undefined;
  try {
    await Promise.race([committing.promise, refresh.then(() => { throw new Error('Renewal never reached commit'); })]);
    disconnect = disconnectGithub(env, bucket);
    await Promise.race([revoking.promise, disconnect.then(() => { throw new Error('Disconnect never reached GitHub'); })]);
    expect(await getGithubConnectionStatus(env, bucket)).toEqual({ connected: false });
    commit.resolve();
    expect(await refresh).toBeNull();
    expect((await changePat()).status).toBe(200);
    revoke.resolve();
    await disconnect;
    expect(revoked).toEqual(['old-app']);
    expect(await getGithubConnectionStatus(env, bucket)).toEqual({ connected: true, source: 'pat', login: undefined });
    expect(await getValidGithubToken(env, bucket)).toBe('replacement-pat');
  } finally {
    commit.resolve();
    revoke.resolve();
    await Promise.allSettled([refresh, disconnect]);
    requests.mockRestore();
  }
});

it('Cloudflare renewal preserves an account selection committed while its provider call was pending', async () => {
  const { env, kv, update } = await fixture();
  kv._store.set(SETUP_KEYS.CLOUDFLARE_OAUTH_CLIENT_ID, 'cf-client');
  kv._set(SETUP_KEYS.CLOUDFLARE_OAUTH_CLIENT_SECRET, { secret: 'cf-client-secret' });
  await storeCloudflareConnection(env, bucket, { source: 'oauth', accessToken: 'cf-old', refreshToken: 'cf-refresh',
    expiresAt: Date.now() + 60_000, accountId: 'original-account' });
  const renewing = deferred();
  const renewal = deferred();
  const requests = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/oauth2/token') {
      renewing.resolve();
      await renewal.promise;
      return Response.json({ access_token: 'cf-rotated', expires_in: 3600 });
    }
    if (path === '/client/v4/accounts' && new Headers(init?.headers).get('Authorization') === 'Bearer cf-old') {
      return Response.json({ success: true, result: [{ id: 'new-selection', name: 'New selection' }] });
    }
    throw new Error(`Unexpected provider call: ${path}`);
  });
  const pending = getValidCloudflareToken(env, bucket);
  try {
    await Promise.race([renewing.promise, pending.then(() => { throw new Error('Cloudflare renewal never reached the provider'); })]);
    expect((await update({ cloudflareAccountId: 'new-selection' })).status).toBe(200);
    renewal.resolve();
    expect(await pending).toBe('cf-rotated');
    expect(await getCloudflareConnectionStatus(env, bucket)).toEqual({ connected: true, source: 'oauth', accountId: 'new-selection' });
  } finally {
    renewal.resolve();
    await pending.catch(() => null);
    requests.mockRestore();
  }
});
