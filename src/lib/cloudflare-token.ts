/**
 * Cloudflare OAuth token store + provider ("Connect to Cloudflare").
 *
 * Mirrors github-token.ts. The per-user Cloudflare token lives in the EXISTING
 * deploy-keys KV entry (`DeployKeys.cloudflareApiToken` + `cloudflareAccountId`,
 * `getDeployKeysKey(bucketName)`) — no new KV key — so it already flows to the
 * container as `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`. "Connect to
 * Cloudflare" populates the same fields the (legacy) manual paste UI filled.
 *
 * Cloudflare's OAuth Applications feature (3-legged authorization_code, with
 * refresh_token via `offline_access`) lets a user authorize their OWN Cloudflare
 * account; the resulting token deploys to that user's account. The admin
 * registers ONE OAuth client per deployment in the Setup wizard (id plain,
 * secret encrypted in KV); this module reads it via getCloudflareProvider.
 *
 * Non-enterprise only: enterprise has no per-user Cloudflare deploy flow, so
 * getCloudflareProvider returns null there (the Setup keys are never set).
 */
import type { DeployKeys, Env } from '../types';
import { getDeployKeysKey, SETUP_KEYS } from './kv-keys';
import { getAndDecrypt, encryptAndStore, getOrImportKey } from './kv-crypto';
import { isEnterpriseMode } from './subscription';
import { createLogger } from './logger';

const logger = createLogger('cloudflare-token');

/** Refresh an OAuth token this many ms before its hard expiry. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

/** Cloudflare OAuth endpoints (verified live via the OIDC discovery doc). */
const OAUTH_AUTHORIZE_URL = 'https://dash.cloudflare.com/oauth2/auth';
const OAUTH_TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token';
const OAUTH_REVOKE_URL = 'https://dash.cloudflare.com/oauth2/revoke';
const ACCOUNTS_URL = 'https://api.cloudflare.com/client/v4/accounts';

export type CloudflareTokenSource = 'oauth' | 'pat';

/** A resolved Cloudflare connection, persisted across the cloudflare fields of DeployKeys. */
export interface CloudflareConnection {
  accessToken: string;
  source: CloudflareTokenSource;
  refreshToken?: string;
  /** Epoch ms when accessToken expires (OAuth tokens with expires_in). */
  expiresAt?: number;
  /** Selected Cloudflare account id; set once resolved (single account or user choice). */
  accountId?: string;
}

/** An account the connected token can act on. */
export interface CloudflareAccount {
  id: string;
  name: string;
}

/** Stable callback path for the Connect-Cloudflare flow (registered on the OAuth client). */
export const CONNECT_CALLBACK_PATH = '/auth/cloudflare/connect/callback';

// --- storage (the one existing deploy-keys entry) --------------------------

async function readDeployKeys(env: Env, bucketName: string): Promise<DeployKeys | null> {
  const cryptoKey = await getOrImportKey(env);
  return getAndDecrypt<DeployKeys>(env.KV, getDeployKeysKey(bucketName), cryptoKey);
}

async function writeDeployKeys(env: Env, bucketName: string, value: DeployKeys): Promise<void> {
  const cryptoKey = await getOrImportKey(env);
  await encryptAndStore(env.KV, getDeployKeysKey(bucketName), value, cryptoKey);
}

function readConnection(dk: DeployKeys | null): CloudflareConnection | null {
  if (!dk?.cloudflareApiToken) return null;
  return {
    accessToken: dk.cloudflareApiToken,
    source: (dk.cloudflareTokenSource ?? 'pat') as CloudflareTokenSource,
    refreshToken: dk.cloudflareRefreshToken ?? undefined,
    expiresAt: dk.cloudflareTokenExpiresAt ?? undefined,
    accountId: dk.cloudflareAccountId ?? undefined,
  };
}

/**
 * Persist a Cloudflare connection into the deploy-keys entry, preserving the
 * GitHub fields. Shared write path for the OAuth flow.
 */
export async function storeCloudflareConnection(
  env: Env,
  bucketName: string,
  conn: CloudflareConnection,
): Promise<void> {
  const existing = (await readDeployKeys(env, bucketName)) ?? {};
  const updated: DeployKeys = {
    ...existing,
    cloudflareApiToken: conn.accessToken,
    cloudflareTokenSource: conn.source,
    cloudflareRefreshToken: conn.refreshToken ?? null,
    cloudflareTokenExpiresAt: conn.expiresAt ?? null,
    cloudflareAccountId: conn.accountId ?? existing.cloudflareAccountId ?? null,
  };
  await writeDeployKeys(env, bucketName, updated);
}

/** Remove all Cloudflare fields; delete the entry entirely if nothing else remains. */
export async function clearCloudflareConnection(env: Env, bucketName: string): Promise<void> {
  const existing = await readDeployKeys(env, bucketName);
  if (!existing) return;
  const remaining: DeployKeys = { ...existing };
  delete remaining.cloudflareApiToken;
  delete remaining.cloudflareTokenSource;
  delete remaining.cloudflareRefreshToken;
  delete remaining.cloudflareTokenExpiresAt;
  delete remaining.cloudflareAccountId;
  if (!remaining.githubToken) {
    await env.KV.delete(getDeployKeysKey(bucketName));
    return;
  }
  await writeDeployKeys(env, bucketName, remaining);
}

/** Non-secret connection status for the panel/settings. */
export async function getCloudflareConnectionStatus(
  env: Env,
  bucketName: string,
): Promise<{ connected: boolean; accountId?: string; source?: CloudflareTokenSource }> {
  const conn = readConnection(await readDeployKeys(env, bucketName));
  if (!conn) return { connected: false };
  return { connected: true, accountId: conn.accountId, source: conn.source };
}

// --- accounts --------------------------------------------------------------

/**
 * List the Cloudflare accounts the token can act on (also validates the token).
 * Throws on an invalid token or API error.
 */
export async function fetchCloudflareAccounts(accessToken: string): Promise<CloudflareAccount[]> {
  const res = await fetch(ACCOUNTS_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Cloudflare accounts endpoint returned ${res.status}`);
  const body = (await res.json()) as { success: boolean; result?: CloudflareAccount[] };
  if (!body.success || !Array.isArray(body.result)) {
    throw new Error('Cloudflare accounts API returned an error');
  }
  return body.result;
}

// --- provider --------------------------------------------------------------

export interface CloudflareOAuthProviderInterface {
  readonly source: 'oauth';
  authorizeUrl(params: { state: string; redirectUri: string; scope: string }): string;
  exchangeCode(code: string, redirectUri: string): Promise<CloudflareConnection>;
  refresh(refreshToken: string): Promise<CloudflareConnection>;
  revoke(accessToken: string): Promise<void>;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number; // seconds
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

/** Standard OAuth2 token-endpoint POST (client_secret_post, form-encoded). */
async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Cloudflare token endpoint returned ${res.status}`);
  const data = (await res.json()) as TokenResponse;
  if (data.error || !data.access_token) {
    throw new Error(`Cloudflare token exchange failed: ${data.error ?? 'no access_token'}`);
  }
  return data;
}

class CloudflareOAuthProvider implements CloudflareOAuthProviderInterface {
  readonly source = 'oauth' as const;
  constructor(private clientId: string, private clientSecret: string) {}

  authorizeUrl({ state, redirectUri, scope }: { state: string; redirectUri: string; scope: string }): string {
    const p = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: redirectUri,
      state,
      scope,
    });
    return `${OAUTH_AUTHORIZE_URL}?${p.toString()}`;
  }

  async exchangeCode(code: string, redirectUri: string): Promise<CloudflareConnection> {
    const t = await postToken({
      grant_type: 'authorization_code',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      redirect_uri: redirectUri,
    });
    return {
      accessToken: t.access_token!,
      source: 'oauth',
      refreshToken: t.refresh_token,
      expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : undefined,
    };
  }

  async refresh(refreshToken: string): Promise<CloudflareConnection> {
    const t = await postToken({
      grant_type: 'refresh_token',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: refreshToken,
    });
    return {
      accessToken: t.access_token!,
      source: 'oauth',
      // Cloudflare may rotate the refresh token; keep the prior one if it doesn't.
      refreshToken: t.refresh_token ?? refreshToken,
      expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : undefined,
    };
  }

  async revoke(accessToken: string): Promise<void> {
    try {
      await fetch(OAUTH_REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: accessToken,
          client_id: this.clientId,
          client_secret: this.clientSecret,
        }).toString(),
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      logger.warn('Cloudflare token revoke failed (continuing)', { err: String(err) });
    }
  }
}

/** Shape of an encrypted Cloudflare client-secret blob at rest. */
interface StoredCloudflareSecret {
  secret: string;
}

/**
 * Resolve the admin-configured Cloudflare OAuth client from Setup→KV. The client
 * id is plain, the secret encrypted. Fails closed (null) when id/secret are not
 * both present or the secret cannot be decrypted (no ENCRYPTION_KEY).
 *
 * Enterprise mode has no per-user Cloudflare deploy flow, so this returns null
 * there (the Setup keys are never written in enterprise).
 */
export async function getCloudflareProvider(env: Env): Promise<CloudflareOAuthProviderInterface | null> {
  if (isEnterpriseMode(env)) return null;
  const clientId = (await env.KV.get(SETUP_KEYS.CLOUDFLARE_OAUTH_CLIENT_ID))?.trim();
  if (!clientId) return null;
  const cryptoKey = await getOrImportKey(env);
  const stored = await getAndDecrypt<StoredCloudflareSecret>(
    env.KV,
    SETUP_KEYS.CLOUDFLARE_OAUTH_CLIENT_SECRET,
    cryptoKey,
  );
  const clientSecret = stored?.secret?.trim();
  if (!clientSecret) return null;
  return new CloudflareOAuthProvider(clientId, clientSecret);
}

/**
 * Secret used to HMAC-sign the Connect-flow OAuth state (CSRF). Reuses the same
 * secret selection as the GitHub connect flow.
 */
export { connectStateSecret } from './github-token';

// --- orchestration ---------------------------------------------------------

/**
 * Return a currently-valid Cloudflare access token for the user, refreshing an
 * OAuth token at/near expiry. Returns null when not connected or when an expired
 * token cannot be refreshed — fail closed: never returns a stale token.
 */
export async function getValidCloudflareToken(env: Env, bucketName: string): Promise<string | null> {
  const conn = readConnection(await readDeployKeys(env, bucketName));
  if (!conn) return null;

  // Manual PAT and OAuth tokens without an expiry have nothing to refresh.
  if (conn.source !== 'oauth' || !conn.expiresAt) return conn.accessToken;

  if (Date.now() < conn.expiresAt - REFRESH_SKEW_MS) return conn.accessToken;

  if (!conn.refreshToken) return null;
  const provider = await getCloudflareProvider(env);
  if (!provider) return null;
  try {
    const refreshed = await provider.refresh(conn.refreshToken);
    // Preserve the selected account across a refresh.
    refreshed.accountId = conn.accountId;
    await storeCloudflareConnection(env, bucketName, refreshed);
    return refreshed.accessToken;
  } catch (err) {
    logger.warn('Cloudflare token refresh failed; failing closed', { err: String(err) });
    return null;
  }
}

/**
 * When the user connected Cloudflare via OAuth, refresh-on-expiry the token before it
 * rides the deploy-keys -> CLOUDFLARE_API_TOKEN env path into the container. Mirrors
 * applyEnterpriseBrowserToken: PAT sources and the enterprise admin-global token pass
 * through untouched (only `cloudflareTokenSource === 'oauth'` triggers the refresh).
 * A refresh that fails closed sets the Cloudflare token to null (no stale token).
 */
export async function applyCloudflareOAuthToken(
  env: Env,
  deployKeys: DeployKeys | null | undefined,
  bucketName: string,
): Promise<DeployKeys | null | undefined> {
  if (deployKeys?.cloudflareTokenSource !== 'oauth' || !deployKeys.cloudflareApiToken) {
    return deployKeys;
  }
  const freshCloudflareToken = await getValidCloudflareToken(env, bucketName);
  return { ...deployKeys, cloudflareApiToken: freshCloudflareToken };
}

/**
 * Exchange an authorization code, persist the connection, and resolve the
 * account. Returns the connection plus the accessible accounts: when exactly one
 * account exists it is auto-selected and persisted; with several, the caller
 * routes the user to account selection.
 */
export async function connectCloudflare(
  env: Env,
  bucketName: string,
  code: string,
  redirectUri: string,
): Promise<{ accounts: CloudflareAccount[]; accountId?: string }> {
  const provider = await getCloudflareProvider(env);
  if (!provider) throw new Error('Cloudflare integration not configured');
  const conn = await provider.exchangeCode(code, redirectUri);

  let accounts: CloudflareAccount[] = [];
  try {
    accounts = await fetchCloudflareAccounts(conn.accessToken);
  } catch (err) {
    logger.warn('Cloudflare account resolution failed after connect', { err: String(err) });
  }
  if (accounts.length === 1) conn.accountId = accounts[0].id;

  await storeCloudflareConnection(env, bucketName, conn);
  return { accounts, accountId: conn.accountId };
}

/**
 * Select the Cloudflare account for an already-connected token. Re-validates the
 * id against the token's accessible accounts (no arbitrary value can be stored).
 */
export async function setCloudflareAccount(
  env: Env,
  bucketName: string,
  accountId: string,
): Promise<boolean> {
  // Resolve a currently-valid token (refresh-on-expiry) and guard the API call so an
  // expired-but-refreshable token can still select an account instead of 500ing.
  const token = await getValidCloudflareToken(env, bucketName);
  if (!token) return false;
  const accounts = await fetchCloudflareAccounts(token).catch(() => null);
  if (!accounts || !accounts.some((a) => a.id === accountId)) return false;
  // Re-read AFTER the refresh so a rotated token is not clobbered by a stale copy.
  const conn = readConnection(await readDeployKeys(env, bucketName));
  if (!conn) return false;
  await storeCloudflareConnection(env, bucketName, { ...conn, accountId });
  return true;
}

/** Disconnect: revoke at Cloudflare (oauth only) and clear the stored fields. */
export async function disconnectCloudflare(env: Env, bucketName: string): Promise<void> {
  const conn = readConnection(await readDeployKeys(env, bucketName));
  if (conn && conn.source === 'oauth') {
    const provider = await getCloudflareProvider(env);
    // Revoke the refresh token when present — per RFC 7009 that invalidates the whole
    // grant family, not just the short-lived access token.
    if (provider) await provider.revoke(conn.refreshToken ?? conn.accessToken);
  }
  await clearCloudflareConnection(env, bucketName);
}
