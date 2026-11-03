import { discoverOAuthServerInfo, extractWWWAuthenticateParams, registerClient, startAuthorization, exchangeAuthorization, refreshAuthorization,
  type OAuthServerInfo } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Env } from '../types';
import { encryptAndStore, encryptForKV, getAndDecrypt, getOrImportKey } from './kv-crypto';
import { getConfiguredMcpPortals, publicHttps, type McpPortal } from './mcp-portals';
export { publicHttps } from './mcp-portals';
import { claimOauthNonce } from './oauth-state';
import { SETUP_KEYS, isValidCustomDomain } from './kv-keys';

export const MCP_CALLBACK_PATH = '/auth/mcp/callback';
export const MCP_CLIENT_METADATA_PATH = '/auth/mcp/client-metadata';
export function mcpPortalClientMetadata(instance: string) {
  return { client_name: 'Codeflare MCP portals', redirect_uris: [`${instance}${MCP_CALLBACK_PATH}`],
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
}
interface PortalBinding {
  owner: string; portal: McpPortal; instance: string; id: string;
  discovery: OAuthServerInfo; client: OAuthClientInformationMixed; resource: string;
}
export interface PortalGrant extends PortalBinding { tokens: OAuthTokens; expiresAt?: number }
interface Pending extends PortalBinding { state: string; verifier: string; expiresAt: number; previous: string | null }
interface Connection { id: string; grant: PortalGrant | null }
const connectionKey = (owner: string, name: string) => `mcp-portal:owner:${encodeURIComponent(owner)}:portal:${name}`;
const pendingKey = (state: string) => `mcp-portal:pending:${state}`;
const random = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');

async function encryption(env: Env): Promise<CryptoKey> {
  const key = await getOrImportKey(env);
  if (!key) throw new Error('MCP portal encryption unavailable');
  return key;
}
async function read<T>(env: Env, key: string): Promise<T | null> {
  const cryptoKey = await encryption(env);
  // This is a new namespace, not a plaintext migration path.
  const raw = await env.KV.get(key);
  if (!raw?.startsWith('v1:')) return null;
  return getAndDecrypt<T>(env.KV, key, cryptoKey);
}
async function write(env: Env, key: string, value: unknown): Promise<void> {
  await encryptAndStore(env.KV, key, value, await encryption(env));
}
/** OAuth control traffic never follows redirects or accepts disabled TLS validation. */
export function portalOAuthFetch(send: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    publicHttps(input instanceof Request ? input.url : String(input));
    const signals = [AbortSignal.timeout(10_000)];
    if (init?.signal) signals.push(init.signal);
    if (input instanceof Request) signals.push(input.signal);
    const response = await send(input, { ...init, redirect: 'error', signal: AbortSignal.any(signals) });
    if (response.status >= 300 && response.status < 400) throw new Error('MCP OAuth redirect refused');
    return response;
  };
}
function validateDiscovery(info: OAuthServerInfo, portal: McpPortal): string {
  const issuer = publicHttps(info.authorizationServerUrl).href;
  const metadata = info.authorizationServerMetadata;
  if (!metadata || !metadata.issuer || metadata.issuer !== info.authorizationServerUrl
    || publicHttps(metadata.issuer).href !== issuer) throw new Error('MCP OAuth issuer mismatch');
  const revocation = 'revocation_endpoint' in metadata ? metadata.revocation_endpoint : undefined;
  if (revocation !== undefined && typeof revocation !== 'string') throw new Error('Invalid MCP revocation endpoint');
  for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.registration_endpoint, revocation]) {
    if (endpoint && publicHttps(endpoint).origin !== new URL(issuer).origin) throw new Error('MCP OAuth endpoint issuer mismatch');
  }
  if (!metadata.authorization_endpoint || !metadata.token_endpoint
    || (!metadata.registration_endpoint && !metadata.client_id_metadata_document_supported)) throw new Error('MCP portal does not support client registration');
  const resource = info.resourceMetadata?.resource;
  const expected = new URL(portal.url); expected.search = '';
  if (!resource || publicHttps(resource).href !== expected.href
    || !info.resourceMetadata?.authorization_servers?.some(value => publicHttps(value).href === issuer)) {
    throw new Error('MCP OAuth resource mismatch');
  }
  return resource;
}
async function configured(env: Env, portal: McpPortal): Promise<boolean> {
  return (await getConfiguredMcpPortals(env.KV)).some(p => p.name === portal.name && p.url === portal.url);
}
function validTokens(tokens: OAuthTokens): void {
  if (!tokens.access_token || tokens.token_type.toLowerCase() !== 'bearer' || !/^[A-Za-z0-9._~+/-]+=*$/.test(tokens.access_token)
    || (tokens.expires_in !== undefined && (!Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0))) throw new Error('Invalid MCP portal grant');
}
export async function beginMcpPortalConnect(env: Env, owner: string, portal: McpPortal, instance: string, send: typeof fetch = fetch): Promise<string> {
  await encryption(env); publicHttps(instance); publicHttps(portal.url);
  if (!await configured(env, portal)) throw new Error('MCP portal configuration changed');
  // An in-flight Connect may not adopt a later Disconnect as its starting generation.
  const previous = await read<Connection>(env, connectionKey(owner, portal.name));
  const fetchFn = portalOAuthFetch(send);
  // Learn the portal's standard protected-resource metadata challenge, without credentials.
  const probe = await fetchFn(portal.url, { headers: { Accept: 'application/json, text/event-stream' } });
  const resourceMetadataUrl = extractWWWAuthenticateParams(probe).resourceMetadataUrl;
  await probe.body?.cancel();
  if (resourceMetadataUrl && publicHttps(resourceMetadataUrl.href).origin !== new URL(portal.url).origin) throw new Error('MCP metadata destination mismatch');
  const discovery = await discoverOAuthServerInfo(portal.url, { fetchFn, resourceMetadataUrl });
  const resource = validateDiscovery(discovery, portal);
  const redirect = `${instance}${MCP_CALLBACK_PATH}`;
  // Prefer DCR when offered: the instance's public metadata handler can still sit
  // behind deployment-wide Access, where an authorization server cannot fetch it.
  const client: OAuthClientInformationMixed = discovery.authorizationServerMetadata?.registration_endpoint
    ? await registerClient(discovery.authorizationServerUrl, { metadata: discovery.authorizationServerMetadata,
      clientMetadata: mcpPortalClientMetadata(instance), scope: discovery.resourceMetadata?.scopes_supported?.join(' '), fetchFn })
    : { client_id: `${instance}${MCP_CLIENT_METADATA_PATH}` };
  const state = random();
  const { authorizationUrl, codeVerifier } = await startAuthorization(discovery.authorizationServerUrl, {
    metadata: discovery.authorizationServerMetadata, clientInformation: client, redirectUrl: redirect, state, resource,
    scope: discovery.resourceMetadata?.scopes_supported?.join(' '),
  });
  if (authorizationUrl.origin !== publicHttps(discovery.authorizationServerMetadata!.authorization_endpoint!).origin) throw new Error('MCP authorization destination mismatch');
  const pending: Pending = { owner, portal, instance, id: random(), discovery, client, resource, state, verifier: codeVerifier,
    expiresAt: Date.now() + 300_000, previous: previous?.id ?? null };
  await env.KV.put(pendingKey(state), await encryptForKV(JSON.stringify(pending), await encryption(env), pendingKey(state)), { expirationTtl: 300 });
  return authorizationUrl.href;
}
export async function finishMcpPortalConnect(env: Env, owner: string, instance: string, state: string, code: string | null,
  issuer?: string, send: typeof fetch = fetch): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(state)) throw new Error('Invalid MCP state');
  const pending = await read<Pending>(env, pendingKey(state));
  if (!pending || pending.owner !== owner || pending.instance !== instance || pending.state !== state || pending.expiresAt <= Date.now()
    || !await configured(env, pending.portal) || (issuer && issuer !== pending.discovery.authorizationServerUrl)) throw new Error('MCP state binding mismatch');
  // Existing nonce mechanism has KV eventual-consistency limits; the provider also enforces single-use codes.
  if (!await claimOauthNonce(env.KV, `mcp-${state}`, 600)) throw new Error('MCP state already used');
  await env.KV.delete(pendingKey(state));
  if (!code || code.length > 8192 || /[\s\x00-\x1f\x7f]/.test(code)) throw new Error('MCP authorization cancelled');
  validateDiscovery(pending.discovery, pending.portal);
  const beforeExchange = await read<Connection>(env, connectionKey(owner, pending.portal.name));
  if ((beforeExchange?.id ?? null) !== pending.previous) throw new Error('MCP connection changed');
  const tokens = await exchangeAuthorization(pending.discovery.authorizationServerUrl, {
    metadata: pending.discovery.authorizationServerMetadata, clientInformation: pending.client, authorizationCode: code,
    codeVerifier: pending.verifier, redirectUri: `${instance}${MCP_CALLBACK_PATH}`, resource: pending.resource, fetchFn: portalOAuthFetch(send),
  });
  validTokens(tokens);
  const current = await read<Connection>(env, connectionKey(owner, pending.portal.name));
  if ((current?.id ?? null) !== pending.previous || !await configured(env, pending.portal)) throw new Error('MCP connection changed');
  const grant: PortalGrant = { owner, portal: pending.portal, instance, id: pending.id, discovery: pending.discovery,
    client: pending.client, resource: pending.resource, tokens, ...(tokens.expires_in ? { expiresAt: Date.now() + tokens.expires_in * 1000 } : {}) };
  await write(env, connectionKey(owner, pending.portal.name), { id: grant.id, grant });
}
export async function getMcpPortalGrant(env: Env, owner: string, portal: McpPortal): Promise<PortalGrant | null> {
  const record = await read<Connection>(env, connectionKey(owner, portal.name));
  const grant = record?.grant;
  if (!grant || record?.id !== grant.id || grant.owner !== owner || grant.portal.name !== portal.name || grant.portal.url !== portal.url
    || !await configured(env, portal)) return null;
  const domain = await env.KV.get(SETUP_KEYS.CUSTOM_DOMAIN);
  if (domain && (!isValidCustomDomain(domain) || grant.instance !== new URL(`https://${domain}`).origin)) return null;
  validateDiscovery(grant.discovery, portal); validTokens(grant.tokens);
  return grant;
}
export async function getValidMcpPortalToken(env: Env, owner: string, portal: McpPortal, send: typeof fetch = fetch): Promise<string | null> {
  const grant = await getMcpPortalGrant(env, owner, portal);
  if (!grant) return null;
  if (!grant.expiresAt || grant.expiresAt > Date.now() + 60_000) return grant.tokens.access_token;
  if (!grant.tokens.refresh_token) return null;
  try {
    const tokens = await refreshAuthorization(grant.discovery.authorizationServerUrl, {
      metadata: grant.discovery.authorizationServerMetadata, clientInformation: grant.client, refreshToken: grant.tokens.refresh_token,
      resource: grant.resource, fetchFn: portalOAuthFetch(send),
    });
    validTokens(tokens);
    const current = await getMcpPortalGrant(env, owner, portal);
    if (!current || current.id !== grant.id || current.tokens.access_token !== grant.tokens.access_token) return null;
    const updated: PortalGrant = { ...grant, tokens, expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined };
    await write(env, connectionKey(owner, portal.name), { id: grant.id, grant: updated });
    // Re-read to reject observed disconnect/config changes. KV is not an atomic CAS store.
    const after = await getMcpPortalGrant(env, owner, portal);
    return after?.id === grant.id ? after.tokens.access_token : null;
  } catch {
    // Another request may have renewed a single-use refresh token first. Reuse
    // only an observed fresh grant in the same generation; never retry the write.
    try {
      const current = await getMcpPortalGrant(env, owner, portal);
      const renewed = current && (current.tokens.access_token !== grant.tokens.access_token
        || current.tokens.refresh_token !== grant.tokens.refresh_token || current.expiresAt !== grant.expiresAt);
      return current?.id === grant.id && renewed && (!current.expiresAt || current.expiresAt > Date.now())
        ? current.tokens.access_token : null;
    } catch { return null; }
  }
}
export async function disconnectMcpPortal(env: Env, owner: string, portal: McpPortal, send: typeof fetch = fetch): Promise<void> {
  const grant = await getMcpPortalGrant(env, owner, portal);
  // Tombstone precedes remote revocation; a failed revoke never restores local access.
  await write(env, connectionKey(owner, portal.name), { id: random(), grant: null });
  const metadata = grant?.discovery.authorizationServerMetadata;
  const endpoint = metadata && 'revocation_endpoint' in metadata ? metadata.revocation_endpoint : undefined;
  if (grant && typeof endpoint === 'string' && endpoint) {
    try {
      await portalOAuthFetch(send)(endpoint, { method: 'POST', body: new URLSearchParams({
        token: grant.tokens.refresh_token ?? grant.tokens.access_token, client_id: grant.client.client_id,
        token_type_hint: grant.tokens.refresh_token ? 'refresh_token' : 'access_token',
      }) });
    } catch { /* Local disconnect is effective even when provider revocation is unavailable. */ }
  }
}
