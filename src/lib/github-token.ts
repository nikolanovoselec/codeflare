/**
 * GitHub token store + OAuth/App token providers.
 *
 * The per-user GitHub token lives in the EXISTING deploy-keys KV entry
 * (`DeployKeys.githubToken`, `getDeployKeysKey(bucketName)`) — no new KV key — so it
 * already flows to the container as `GH_TOKEN` for non-enterprise modes and is read
 * by the enterprise egress interceptor. "Connect GitHub" populates the same field the
 * manual PAT UI fills (which marks source `'pat'`).
 *
 * Two providers behind one seam, selected by deploy config:
 *  - GitHubAppUserProvider (enterprise / EMU): user-to-server tokens, ~8h, refreshable.
 *  - OAuthAppProvider       (non-EMU SaaS):     long-lived OAuth App tokens.
 *
 * The container never holds the real token in enterprise mode (the interceptor injects
 * it at the github.com boundary); this module is the single server-side source of truth.
 */
import type { DeployKeys, Env } from '../types';
import { getDeployKeysKey, SETUP_KEYS } from './kv-keys';
import { getAndDecrypt, encryptAndStore, getOrImportKey } from './kv-crypto';
import { createLogger } from './logger';

const logger = createLogger('github-token');

/** Refresh an App token this many ms before its hard expiry. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export type GithubTokenSource = 'app' | 'oauth' | 'pat';

/** A resolved GitHub connection, persisted across the github fields of DeployKeys. */
export interface GithubConnection {
  accessToken: string;
  source: GithubTokenSource;
  refreshToken?: string;
  /** Epoch ms when accessToken expires (App tokens only). */
  expiresAt?: number;
  /** GitHub login (handle) for display; never a secret. */
  login?: string;
}

/** Stable callback path for the Connect-GitHub flow (registered on the App/OAuth App). */
export const CONNECT_CALLBACK_PATH = '/auth/github/connect/callback';

/**
 * Secret used to HMAC-sign the Connect-flow OAuth state (CSRF). Prefers the SaaS
 * session-JWT secret; falls back to the encryption key (always present where the
 * integration is usable, since the token is encrypted at rest). Null ⇒ unusable.
 */
export function connectStateSecret(env: Env): string | null {
  return env.OAUTH_JWT_SECRET ?? env.ENCRYPTION_KEY ?? null;
}

// --- host helpers ----------------------------------------------------------

function webHost(env: Env): string {
  return env.GITHUB_HOST?.trim() || 'github.com';
}
function apiHost(env: Env): string {
  return env.GITHUB_API_HOST?.trim() || 'api.github.com';
}

// --- storage (the one existing deploy-keys entry) --------------------------

async function readDeployKeys(env: Env, bucketName: string): Promise<DeployKeys | null> {
  const cryptoKey = await getOrImportKey(env);
  return getAndDecrypt<DeployKeys>(env.KV, getDeployKeysKey(bucketName), cryptoKey);
}

async function writeDeployKeys(env: Env, bucketName: string, value: DeployKeys): Promise<void> {
  const cryptoKey = await getOrImportKey(env);
  await encryptAndStore(env.KV, getDeployKeysKey(bucketName), value, cryptoKey);
}

function readConnection(dk: DeployKeys | null): GithubConnection | null {
  if (!dk?.githubToken) return null;
  return {
    accessToken: dk.githubToken,
    source: (dk.githubTokenSource ?? 'pat') as GithubTokenSource,
    refreshToken: dk.githubRefreshToken ?? undefined,
    expiresAt: dk.githubTokenExpiresAt ?? undefined,
    login: dk.githubLogin ?? undefined,
  };
}

/**
 * Persist a GitHub connection into the deploy-keys entry, preserving the Cloudflare
 * deploy fields. Shared write path for the App + OAuth providers (manual PAT writes
 * go through the deploy-keys route, which sets source `'pat'`).
 */
export async function storeGithubConnection(
  env: Env,
  bucketName: string,
  conn: GithubConnection,
): Promise<void> {
  const existing = (await readDeployKeys(env, bucketName)) ?? {};
  const updated: DeployKeys = {
    ...existing,
    githubToken: conn.accessToken,
    githubTokenSource: conn.source,
    githubRefreshToken: conn.refreshToken ?? null,
    githubTokenExpiresAt: conn.expiresAt ?? null,
    githubLogin: conn.login ?? existing.githubLogin ?? null,
  };
  await writeDeployKeys(env, bucketName, updated);
}

/** Remove all GitHub fields; delete the entry entirely if nothing else remains. */
export async function clearGithubConnection(env: Env, bucketName: string): Promise<void> {
  const existing = await readDeployKeys(env, bucketName);
  if (!existing) return;
  const remaining: DeployKeys = { ...existing };
  delete remaining.githubToken;
  delete remaining.githubTokenSource;
  delete remaining.githubRefreshToken;
  delete remaining.githubTokenExpiresAt;
  delete remaining.githubLogin;
  if (!remaining.cloudflareApiToken && !remaining.cloudflareAccountId) {
    await env.KV.delete(getDeployKeysKey(bucketName));
    return;
  }
  await writeDeployKeys(env, bucketName, remaining);
}

/** Non-secret connection status for the panel. */
export async function getGithubConnectionStatus(
  env: Env,
  bucketName: string,
): Promise<{ connected: boolean; login?: string; source?: GithubTokenSource }> {
  const conn = readConnection(await readDeployKeys(env, bucketName));
  if (!conn) return { connected: false };
  return { connected: true, login: conn.login, source: conn.source };
}

// --- providers -------------------------------------------------------------

export interface GithubOAuthProvider {
  readonly source: 'app' | 'oauth';
  /** `scope` (OAuth-App only) overrides the default scope set; the App path ignores it. */
  authorizeUrl(params: { state: string; redirectUri: string; scope?: string }): string;
  exchangeCode(code: string, redirectUri: string): Promise<GithubConnection>;
  /** Throws if refresh is unsupported (OAuth App) or fails. */
  refresh(refreshToken: string): Promise<GithubConnection>;
  /** Best-effort revoke at GitHub. */
  revoke(accessToken: string): Promise<void>;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number; // seconds
  scope?: string;
  error?: string;
  error_description?: string;
}

async function postToken(env: Env, body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`https://${webHost(env)}/login/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`GitHub token endpoint returned ${res.status}`);
  const data = (await res.json()) as TokenResponse;
  if (data.error || !data.access_token) {
    throw new Error(`GitHub token exchange failed: ${data.error ?? 'no access_token'}`);
  }
  return data;
}

async function fetchLogin(env: Env, accessToken: string): Promise<string | undefined> {
  try {
    const res = await fetch(`https://${apiHost(env)}/user`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Codeflare',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return undefined;
    const u = (await res.json()) as { login?: string };
    return u.login;
  } catch {
    return undefined;
  }
}

async function revokeAtGithub(
  env: Env,
  clientId: string,
  clientSecret: string,
  accessToken: string,
): Promise<void> {
  try {
    const basic = btoa(`${clientId}:${clientSecret}`);
    await fetch(`https://${apiHost(env)}/applications/${clientId}/token`, {
      method: 'DELETE',
      headers: {
        Authorization: `Basic ${basic}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Codeflare',
      },
      body: JSON.stringify({ access_token: accessToken }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    logger.warn('GitHub token revoke failed (continuing)', { err: String(err) });
  }
}

class GitHubAppUserProvider implements GithubOAuthProvider {
  readonly source = 'app' as const;
  constructor(private env: Env, private clientId: string, private clientSecret: string) {}

  authorizeUrl({ state, redirectUri }: { state: string; redirectUri: string; scope?: string }): string {
    // GitHub App user-to-server: scopes come from the App's installed permissions,
    // so no `scope` param is sent (the tier-derived scope is ignored here).
    const p = new URLSearchParams({ client_id: this.clientId, state, redirect_uri: redirectUri });
    return `https://${webHost(this.env)}/login/oauth/authorize?${p.toString()}`;
  }

  async exchangeCode(code: string, redirectUri: string): Promise<GithubConnection> {
    const t = await postToken(this.env, {
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      redirect_uri: redirectUri,
    });
    return {
      accessToken: t.access_token!,
      source: 'app',
      refreshToken: t.refresh_token,
      expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : undefined,
      login: await fetchLogin(this.env, t.access_token!),
    };
  }

  async refresh(refreshToken: string): Promise<GithubConnection> {
    const t = await postToken(this.env, {
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    // Login is unchanged across a refresh; the caller preserves the prior value.
    return {
      accessToken: t.access_token!,
      source: 'app',
      refreshToken: t.refresh_token,
      expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : undefined,
    };
  }

  async revoke(accessToken: string): Promise<void> {
    await revokeAtGithub(this.env, this.clientId, this.clientSecret, accessToken);
  }
}

class OAuthAppProvider implements GithubOAuthProvider {
  readonly source = 'oauth' as const;
  private static readonly SCOPES = 'repo read:org workflow';
  constructor(private env: Env, private clientId: string, private clientSecret: string) {}

  authorizeUrl({ state, redirectUri, scope }: { state: string; redirectUri: string; scope?: string }): string {
    const p = new URLSearchParams({
      client_id: this.clientId,
      state,
      redirect_uri: redirectUri,
      scope: scope ?? OAuthAppProvider.SCOPES,
    });
    return `https://${webHost(this.env)}/login/oauth/authorize?${p.toString()}`;
  }

  async exchangeCode(code: string, redirectUri: string): Promise<GithubConnection> {
    const t = await postToken(this.env, {
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      redirect_uri: redirectUri,
    });
    return {
      accessToken: t.access_token!,
      source: 'oauth',
      login: await fetchLogin(this.env, t.access_token!),
    };
  }

  async refresh(): Promise<GithubConnection> {
    throw new Error('OAuth App tokens do not support refresh');
  }

  async revoke(accessToken: string): Promise<void> {
    await revokeAtGithub(this.env, this.clientId, this.clientSecret, accessToken);
  }
}

/** Shape of an encrypted GitHub client-secret blob at rest (REQ-GITHUB-008). */
interface StoredGithubSecret {
  secret: string;
}

/**
 * Resolve the admin-configured provider from Setup→KV (REQ-GITHUB-008). Set by an
 * admin in the Setup wizard, which is admin-gated in ANY mode (enterprise AND
 * non-enterprise), so this path applies everywhere. GITHUB_PROVIDER_TYPE selects
 * the pair; the client id is plain, the secret encrypted. Fails closed (null) when
 * the selected provider's id/secret are not both present, or the secret cannot be
 * decrypted (no ENCRYPTION_KEY) — never an ambiguous provider.
 */
async function getProviderFromKv(env: Env): Promise<GithubOAuthProvider | null> {
  const type = await env.KV.get(SETUP_KEYS.GITHUB_PROVIDER_TYPE);
  if (type !== 'app' && type !== 'oauth') return null;
  const idKey = type === 'app' ? SETUP_KEYS.GITHUB_APP_CLIENT_ID : SETUP_KEYS.GITHUB_OAUTH_CLIENT_ID;
  const secretKey = type === 'app' ? SETUP_KEYS.GITHUB_APP_CLIENT_SECRET : SETUP_KEYS.GITHUB_OAUTH_CLIENT_SECRET;
  const clientId = (await env.KV.get(idKey))?.trim();
  if (!clientId) return null;
  const cryptoKey = await getOrImportKey(env);
  const stored = await getAndDecrypt<StoredGithubSecret>(env.KV, secretKey, cryptoKey);
  const clientSecret = stored?.secret?.trim();
  if (!clientSecret) return null;
  return type === 'app'
    ? new GitHubAppUserProvider(env, clientId, clientSecret)
    : new OAuthAppProvider(env, clientId, clientSecret);
}

/**
 * Select the GitHub OAuth/App provider. An admin can configure it in the Setup
 * wizard (KV) in ANY mode; a complete config wins. Otherwise deploy-time env vars
 * are used (GitHub App precedence over OAuth App) — the unchanged env fallback that
 * non-enterprise deployments without a Setup config keep relying on. Neither ⇒ null.
 */
export async function getGithubProvider(env: Env): Promise<GithubOAuthProvider | null> {
  const fromKv = await getProviderFromKv(env);
  if (fromKv) return fromKv;
  if (env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET) {
    return new GitHubAppUserProvider(env, env.GITHUB_APP_CLIENT_ID, env.GITHUB_APP_CLIENT_SECRET);
  }
  if (env.OAUTH_CLIENT_ID && env.OAUTH_CLIENT_SECRET) {
    return new OAuthAppProvider(env, env.OAUTH_CLIENT_ID, env.OAUTH_CLIENT_SECRET);
  }
  return null;
}

// --- orchestration ---------------------------------------------------------

/**
 * Return a currently-valid GitHub access token for the user, refreshing an App token
 * that is at/near expiry. Returns null when not connected or when an expired App token
 * cannot be refreshed — fail closed: never returns a stale token.
 */
export async function getValidGithubToken(env: Env, bucketName: string): Promise<string | null> {
  const conn = readConnection(await readDeployKeys(env, bucketName));
  if (!conn) return null;

  // Manual PAT and long-lived OAuth tokens have no expiry.
  if (conn.source !== 'app' || !conn.expiresAt) return conn.accessToken;

  if (Date.now() < conn.expiresAt - REFRESH_SKEW_MS) return conn.accessToken;

  // Expiring/expired App token — refresh, or fail closed.
  if (!conn.refreshToken) return null;
  const provider = await getGithubProvider(env);
  if (!provider || provider.source !== 'app') return null;
  try {
    const refreshed = await provider.refresh(conn.refreshToken);
    if (!refreshed.login) refreshed.login = conn.login;
    await storeGithubConnection(env, bucketName, refreshed);
    return refreshed.accessToken;
  } catch (err) {
    logger.warn('GitHub App token refresh failed; failing closed', { err: String(err) });
    return null;
  }
}

/** Exchange an OAuth/App authorization code and persist the connection. */
export async function connectGithub(
  env: Env,
  bucketName: string,
  code: string,
  redirectUri: string,
): Promise<GithubConnection> {
  const provider = await getGithubProvider(env);
  if (!provider) throw new Error('GitHub integration not configured');
  const conn = await provider.exchangeCode(code, redirectUri);
  await storeGithubConnection(env, bucketName, conn);
  return conn;
}

/** Disconnect: revoke at GitHub (app/oauth only) and clear the stored fields. */
export async function disconnectGithub(env: Env, bucketName: string): Promise<void> {
  const conn = readConnection(await readDeployKeys(env, bucketName));
  if (conn && conn.source !== 'pat') {
    const provider = await getGithubProvider(env);
    if (provider) await provider.revoke(conn.accessToken);
  }
  await clearGithubConnection(env, bucketName);
}
