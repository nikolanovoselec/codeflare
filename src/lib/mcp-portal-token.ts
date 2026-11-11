import { discoverOAuthServerInfo, extractWWWAuthenticateParams, registerClient, startAuthorization, exchangeAuthorization, refreshAuthorization,
  type OAuthServerInfo } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Env } from '../types';
import { decryptFromKV, encryptAndStore, encryptForKV, getOrImportKey } from './kv-crypto';
import { getConfiguredMcpPortals, publicHttps, type McpPortal } from './mcp-portals';
export { publicHttps } from './mcp-portals';
import { claimOauthNonce } from './oauth-state';
import { SETUP_KEYS, isValidCustomDomain } from './kv-keys';
import { createLogger } from './logger';

const logger = createLogger('mcp-portal-oauth');
type OAuthStage = 'configuration' | 'discovery' | 'discovery-validation' | 'registration' | 'authorization'
  | 'pending-publication' | 'state-lookup' | 'state-binding' | 'nonce-claim' | 'pending-consume'
  | 'authorization-response' | 'connection-check' | 'code-exchange' | 'token-validation'
  | 'publication-check' | 'grant-publication' | 'refresh' | 'readback' | 'winner-lookup';

/** Closed metadata only; logging failures must never change an OAuth outcome. */
function oauthDiagnostic(operation: 'connect' | 'callback' | 'renewal', stage: OAuthStage,
  outcome: 'completed' | 'rejected' | 'reused-current', error?: unknown): void {
  try {
    let detail: McpPortalTokenFailure['detail'] | 'invalid_client_metadata' = undefined;
    if (outcome === 'rejected') {
      detail = error && typeof error === 'object' && 'errorCode' in error && error.errorCode === 'invalid_client_metadata'
        ? 'invalid_client_metadata' : refreshErrorDetail(error);
    }
    const data = { operation, stage, outcome, ...(detail ? { detail } : {}) };
    if (outcome === 'rejected') logger.warn('MCP OAuth outcome', data);
    else logger.info('MCP OAuth outcome', data);
  } catch { /* Observability is best effort, never an authorization dependency. */ }
}

const MCP_CALLBACK_PATH = '/auth/mcp/callback';
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
  try {
    return JSON.parse(await decryptFromKV(raw.slice(3), cryptoKey, key)) as T;
  } catch {
    return null;
  }
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
    const response = await send(input, { ...init, redirect: 'manual', signal: AbortSignal.any(signals) });
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
export async function beginMcpPortalConnect(env: Env, owner: string, portal: McpPortal, instance: string, send: typeof fetch = fetch,
  expectedGrantId?: string): Promise<string> {
  let stage: OAuthStage = 'configuration';
  try {
    await encryption(env); publicHttps(instance); publicHttps(portal.url);
    if (!await configured(env, portal)) throw new Error('MCP portal configuration changed');
    // An in-flight Connect may not adopt a later Disconnect as its starting generation.
    const previous = await read<Connection>(env, connectionKey(owner, portal.name));
    if (expectedGrantId !== undefined) {
      const bound = await getMcpPortalGrant(env, owner, portal);
      if (!bound || bound.id !== expectedGrantId || previous?.id !== expectedGrantId || bound.instance !== instance) {
        throw new Error('MCP connection changed');
      }
    }
    const fetchFn = portalOAuthFetch(send);
    // Learn the portal's standard protected-resource metadata challenge, without credentials.
    stage = 'discovery';
    const probe = await fetchFn(portal.url, { headers: { Accept: 'application/json, text/event-stream' } });
    const resourceMetadataUrl = extractWWWAuthenticateParams(probe).resourceMetadataUrl;
    await probe.body?.cancel();
    if (resourceMetadataUrl && publicHttps(resourceMetadataUrl.href).origin !== new URL(portal.url).origin) throw new Error('MCP metadata destination mismatch');
    const discovery = await discoverOAuthServerInfo(portal.url, { fetchFn, resourceMetadataUrl });
    stage = 'discovery-validation';
    const resource = validateDiscovery(discovery, portal);
    const redirect = `${instance}${MCP_CALLBACK_PATH}`;
    // Prefer DCR when offered: the instance's public metadata handler can still sit
    // behind deployment-wide Access, where an authorization server cannot fetch it.
    stage = 'registration';
    const client: OAuthClientInformationMixed = discovery.authorizationServerMetadata?.registration_endpoint
      ? await registerClient(discovery.authorizationServerUrl, { metadata: discovery.authorizationServerMetadata,
        clientMetadata: mcpPortalClientMetadata(instance), scope: discovery.resourceMetadata?.scopes_supported?.join(' '), fetchFn })
      : { client_id: `${instance}${MCP_CLIENT_METADATA_PATH}` };
    stage = 'authorization';
    const state = random();
    const { authorizationUrl, codeVerifier } = await startAuthorization(discovery.authorizationServerUrl, {
      metadata: discovery.authorizationServerMetadata, clientInformation: client, redirectUrl: redirect, state, resource,
      scope: discovery.resourceMetadata?.scopes_supported?.join(' '),
    });
    if (authorizationUrl.origin !== publicHttps(discovery.authorizationServerMetadata!.authorization_endpoint!).origin) throw new Error('MCP authorization destination mismatch');
    stage = 'connection-check';
    if (expectedGrantId !== undefined) {
      const bound = await getMcpPortalGrant(env, owner, portal);
      if (!bound || bound.id !== expectedGrantId || bound.instance !== instance) throw new Error('MCP connection changed');
    }
    stage = 'pending-publication';
    const pending: Pending = { owner, portal, instance, id: random(), discovery, client, resource, state, verifier: codeVerifier,
      expiresAt: Date.now() + 300_000, previous: previous?.id ?? null };
    await env.KV.put(pendingKey(state), await encryptForKV(JSON.stringify(pending), await encryption(env), pendingKey(state)), { expirationTtl: 300 });
    oauthDiagnostic('connect', stage, 'completed');
    return authorizationUrl.href;
  } catch (error) {
    oauthDiagnostic('connect', stage, 'rejected', error);
    throw error;
  }
}
export async function finishMcpPortalConnect(env: Env, owner: string, instance: string, state: string, code: string | null,
  issuer?: string, send: typeof fetch = fetch): Promise<void> {
  let stage: OAuthStage = 'state-lookup';
  try {
    if (!/^[a-f0-9]{64}$/.test(state)) throw new Error('Invalid MCP state');
    const pending = await read<Pending>(env, pendingKey(state));
    stage = 'state-binding';
    if (!pending || pending.owner !== owner || pending.instance !== instance || pending.state !== state || pending.expiresAt <= Date.now()
      || !await configured(env, pending.portal) || (issuer && issuer !== pending.discovery.authorizationServerUrl)) throw new Error('MCP state binding mismatch');
    // Existing nonce mechanism has KV eventual-consistency limits; the provider also enforces single-use codes.
    stage = 'nonce-claim';
    if (!await claimOauthNonce(env.KV, `mcp-${state}`, 600)) throw new Error('MCP state already used');
    stage = 'pending-consume';
    await env.KV.delete(pendingKey(state));
    stage = 'authorization-response';
    if (!code || code.length > 8192 || /[\s\x00-\x1f\x7f]/.test(code)) throw new Error('MCP authorization cancelled');
    stage = 'discovery-validation';
    validateDiscovery(pending.discovery, pending.portal);
    stage = 'connection-check';
    const beforeExchange = await read<Connection>(env, connectionKey(owner, pending.portal.name));
    if ((beforeExchange?.id ?? null) !== pending.previous) throw new Error('MCP connection changed');
    stage = 'code-exchange';
    const tokens = await exchangeAuthorization(pending.discovery.authorizationServerUrl, {
      metadata: pending.discovery.authorizationServerMetadata, clientInformation: pending.client, authorizationCode: code,
      codeVerifier: pending.verifier, redirectUri: `${instance}${MCP_CALLBACK_PATH}`, resource: pending.resource, fetchFn: portalOAuthFetch(send),
    });
    stage = 'token-validation';
    validTokens(tokens);
    stage = 'publication-check';
    const current = await read<Connection>(env, connectionKey(owner, pending.portal.name));
    if ((current?.id ?? null) !== pending.previous || !await configured(env, pending.portal)) throw new Error('MCP connection changed');
    const grant: PortalGrant = { owner, portal: pending.portal, instance, id: pending.id, discovery: pending.discovery,
      client: pending.client, resource: pending.resource, tokens, ...(tokens.expires_in ? { expiresAt: Date.now() + tokens.expires_in * 1000 } : {}) };
    stage = 'grant-publication';
    await write(env, connectionKey(owner, pending.portal.name), { id: grant.id, grant });
    oauthDiagnostic('callback', stage, 'completed');
  } catch (error) {
    oauthDiagnostic('callback', stage, 'rejected', error);
    throw error;
  }
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
export interface McpPortalTokenFailure {
  reason: 'lookup-unavailable' | 'lookup-throws' | 'no-refresh-token' | 'refresh-error' | 'concurrent-change' | 'readback-rejected';
  detail?: 'timeout' | 'other' | 'invalid_grant' | 'invalid_client' | 'invalid_request' | 'unauthorized_client'
    | 'unsupported_grant_type' | 'invalid_scope' | 'invalid_target' | 'server_error' | 'temporarily_unavailable';
}
function refreshErrorDetail(error: unknown): McpPortalTokenFailure['detail'] {
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout';
  const code = error && typeof error === 'object' && 'errorCode' in error ? error.errorCode : undefined;
  switch (code) {
    case 'invalid_grant': case 'invalid_client': case 'invalid_request': case 'unauthorized_client':
    case 'unsupported_grant_type': case 'invalid_scope': case 'invalid_target': case 'server_error': case 'temporarily_unavailable': return code;
    default: return 'other';
  }
}
function changedTokens(current: PortalGrant, original: PortalGrant): boolean {
  return current.tokens.access_token !== original.tokens.access_token
    || current.tokens.refresh_token !== original.tokens.refresh_token || current.expiresAt !== original.expiresAt;
}
function renewedGrant(current: PortalGrant | null, original: PortalGrant): current is PortalGrant {
  return !!current && current.id === original.id && changedTokens(current, original)
    && (!current.expiresAt || current.expiresAt > Date.now());
}
export async function getValidMcpPortalToken(env: Env, owner: string, portal: McpPortal, send: typeof fetch = fetch,
  report?: (failure: McpPortalTokenFailure) => void): Promise<string | null> {
  let diagnosticStage: OAuthStage | undefined;
  let renewalError: unknown;
  const fail = (reason: McpPortalTokenFailure['reason'], detail?: McpPortalTokenFailure['detail']) => {
    if (diagnosticStage) oauthDiagnostic('renewal', diagnosticStage, 'rejected', renewalError);
    report?.({ reason, ...(detail ? { detail } : {}) }); return null;
  };
  const renewed = (token: string, outcome: 'completed' | 'reused-current' = 'completed') => {
    oauthDiagnostic('renewal', diagnosticStage!, outcome);
    return token;
  };
  let grant: PortalGrant | null;
  try { grant = await getMcpPortalGrant(env, owner, portal); }
  catch (error) { fail('lookup-throws'); throw error; }
  if (!grant) return fail('lookup-unavailable');
  if (!grant.expiresAt || grant.expiresAt > Date.now() + 60_000) return grant.tokens.access_token;
  if (!grant.tokens.refresh_token) return fail('no-refresh-token');
  let stage: 'refresh' | 'publication' = 'refresh';
  diagnosticStage = 'refresh';
  try {
    const tokens = await refreshAuthorization(grant.discovery.authorizationServerUrl, {
      metadata: grant.discovery.authorizationServerMetadata, clientInformation: grant.client, refreshToken: grant.tokens.refresh_token,
      resource: grant.resource, fetchFn: portalOAuthFetch(send),
    });
    diagnosticStage = 'token-validation';
    validTokens(tokens);
    stage = 'publication';
    diagnosticStage = 'publication-check';
    const current = await getMcpPortalGrant(env, owner, portal);
    if (!current || current.id !== grant.id) return fail('concurrent-change');
    if (changedTokens(current, grant)) {
      return renewedGrant(current, grant) ? renewed(current.tokens.access_token, 'reused-current') : fail('concurrent-change');
    }
    const updated: PortalGrant = { ...grant, tokens, expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined };
    diagnosticStage = 'grant-publication';
    await write(env, connectionKey(owner, portal.name), { id: grant.id, grant: updated });
    diagnosticStage = 'readback';
    // Reject observed disconnect/config changes; KV is not an atomic CAS store.
    const after = await getMcpPortalGrant(env, owner, portal);
    if (!after || after.id !== grant.id) return fail('readback-rejected');
    if (renewedGrant(after, grant)) return renewed(after.tokens.access_token);
    // An unchanged same-generation read may lag our completed write. Never send
    // its old access token instead of the successful refresh result.
    return !changedTokens(after, grant) ? renewed(updated.tokens.access_token) : fail('readback-rejected');
  } catch (error) {
    // A losing rotating refresh before winner publication remains fail-closed.
    // Only an observed renewed same-generation grant is safe; never retry writes.
    renewalError = error;
    try {
      const current = await getMcpPortalGrant(env, owner, portal);
      if (renewedGrant(current, grant)) {
        diagnosticStage = 'winner-lookup';
        return renewed(current.tokens.access_token, 'reused-current');
      }
    } catch { /* No usable observed renewal. */ }
    return stage === 'refresh' ? fail('refresh-error', refreshErrorDetail(error)) : fail('readback-rejected');
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
