/**
 * A failed route lookup must not delete saved routes.
 *
 * These helpers read Cloudflare AI Gateway configuration. Callers supply the
 * saved or draft connection, and we build management API URLs from its account
 * and gateway IDs. We never follow URLs from a response or write gateway
 * configuration, provider credentials, routes, or saved application settings.
 *
 * Dynamic Routing returns data.routes with page/per_page. Provider bindings use
 * result/result_info. Keep those pagination rules separate: requiring provider
 * count fields on a Dynamic response rejects a valid route list.
 *
 * The route and Native binding readers throw on incomplete inventories. Returning
 * the rows collected so far would let reconciliation mistake unread routes or
 * bindings for deleted ones. The Dynamic Routing SDK contract is here:
 * https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/ai-gateway/dynamic-routing.ts
 */
import { z } from 'zod';
import type { Env } from '../types';
import { getAigConfig } from './aig-config';

// Allow 1 MiB and 10 seconds per request, including reading the response body.
// Each inventory scan also has a page and row limit. These are our budgets;
// they do not describe Cloudflare account quotas or endpoint limits.
const MAX_MANAGEMENT_RESPONSE_BYTES = 1024 * 1024;
const MANAGEMENT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_PROVIDER_CONFIG_PAGES = 10;
const MAX_PROVIDER_CONFIGS = 1000;
const MAX_DYNAMIC_ROUTE_PAGES = 10;
const MAX_DYNAMIC_ROUTES = 1000;
// We can recognize these built-in slugs even if the custom-provider lookup
// fails. This list does not restrict model versions or provider configurations.
const KNOWN_NATIVE_PROVIDERS = new Set(['aws-bedrock', 'google-ai-studio', 'openai']);
const providerSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const providerAliasSchema = z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/);
// Saved routing uses these names as dictionary keys. Reject __proto__ and
// similar keys, along with path separators and control characters.
export const dynamicRouteSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
  .refine((value) => !['__proto__', 'prototype', 'constructor'].includes(value.toLowerCase()));
// Inspect draft connections without saving them. An account API URL has no
// gateway name in its path, so the draft must supply a separate gateway ID.
export const gatewayDraftSchema = z.object({
  gatewayUrl: z.string().trim().max(512).refine((value) => parseGatewayUrl(value) !== null),
  gatewayId: dynamicRouteSchema.optional(),
  replacementToken: z.string().trim().max(2048).regex(/^[^\u0000-\u001f\u007f]*$/).optional(),
}).strict().superRefine((value, context) => {
  if (parseGatewayUrl(value.gatewayUrl)?.kind === 'account-api' && !value.gatewayId) {
    context.addIssue({ code: 'custom', message: 'AI Gateway name is required for an account API URL', path: ['gatewayId'] });
  }
});
// Administrators can label backends for display. Those descriptions neither
// prove a backend's identity nor change the route graph owned by the gateway.
export const backendDescriptionsSchema = z.record(
  z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).refine((value) => !['__proto__', 'prototype', 'constructor'].includes(value.toLowerCase())),
  z.string().trim().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/),
).refine((value) => Object.keys(value).length <= 256);
export type GatewayDraft = z.infer<typeof gatewayDraftSchema>;
export interface GatewayConnection { gatewayUrl?: string; gatewayId?: string; token?: string }
export interface ParsedGatewayUrl { accountId: string; gatewayId?: string; kind: 'legacy' | 'account-api'; canonicalUrl: string }
export interface ConnectionStatus { status: 'ready' | 'missing' | 'permission-denied' | 'unavailable'; message: string }

// Start with basic object and string checks on untrusted JSON. Each endpoint
// then checks its own fields; a JSON object alone tells us very little.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function safeString(value: unknown, maxLength = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value);
}
/**
 * The two URL forms carry different information. A legacy gateway URL contains
 * both the account and gateway IDs; an account API URL supplies only the account.
 * Both must use HTTPS, without embedded credentials or a non-default port.
 *
 * Legacy URLs cannot include a query or fragment. For account API URLs, keep
 * the account root and drop the inference path, query and fragment. The readers
 * below build fixed-origin management URLs from the extracted IDs.
 */
export function parseGatewayUrl(raw: string | undefined): ParsedGatewayUrl | null {
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
  if (url.hostname === 'gateway.ai.cloudflare.com') {
    if (url.search || url.hash) return null;
    const match = /^\/v1\/([a-f0-9]{32})\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?:\/|\/compat\/?)?$/i.exec(url.pathname);
    return match ? { accountId: match[1], gatewayId: match[2], kind: 'legacy', canonicalUrl: `https://gateway.ai.cloudflare.com/v1/${match[1]}/${match[2]}` } : null;
  }
  if (url.hostname === 'api.cloudflare.com') {
    const match = /^\/client\/v4\/accounts\/([a-f0-9]{32})(\/.*)?$/i.exec(url.pathname);
    if (!match) return null;
    const suffix = match[2] ?? '';
    if (!/^\/?$|^\/ai\/?$|^\/ai\/run\/?$|^\/ai\/v1(?:\/(?:chat\/completions|responses|messages|models))?\/?$/i.test(suffix)) return null;
    return { accountId: match[1], kind: 'account-api', canonicalUrl: `https://api.cloudflare.com/client/v4/accounts/${match[1]}/` };
  }
  return null;
}
/** Use the gateway named in a legacy URL, even if a separate ID was supplied. */
export function gatewayCoordinates(connection: GatewayConnection): { accountId: string; gatewayId: string } | null {
  const parsed = parseGatewayUrl(connection.gatewayUrl);
  if (!parsed) return null;
  const gatewayId = parsed.gatewayId ?? connection.gatewayId;
  return gatewayId && dynamicRouteSchema.safeParse(gatewayId).success ? { accountId: parsed.accountId, gatewayId } : null;
}
/**
 * Apply validated draft values for this inspection without saving them.
 * Leave credential loading and decryption to getAigConfig. A missing or blank
 * replacement token means keep the saved token, not clear it.
 *
 * Take the gateway name from a legacy URL. Account API URLs need the separate
 * gateway ID from the draft, or the saved ID when the draft omits it.
 */
export async function resolveGatewayConnection(env: Env, draft?: GatewayDraft): Promise<GatewayConnection> {
  const saved = await getAigConfig(env);
  const gatewayUrl = draft?.gatewayUrl ?? saved.gatewayUrl;
  const parsed = parseGatewayUrl(gatewayUrl);
  return {
    gatewayUrl: parsed?.canonicalUrl ?? gatewayUrl,
    gatewayId: parsed?.kind === 'legacy' ? undefined : draft?.gatewayId ?? saved.gatewayId,
    token: draft?.replacementToken?.trim() || saved.token,
  };
}
// The HTTP status is enough to classify this failure. Keep response bodies,
// Authorization headers and provider details out of the error.
class GatewayManagementError extends Error {
  constructor(public readonly status: number) { super('management_request_failed'); }
}
/**
 * Report permission denial only after a management HTTP 401 or 403.
 * A timeout or rejected response shape does not prove that credentials were
 * lost. Neither does an incomplete inventory. Report those as unavailable.
 *
 * AI Gateway Read allows inspection; Run allows inference. A working model
 * request is not enough to establish management access.
 */
export function connectionStatus(error?: unknown, missing = false): ConnectionStatus {
  if (missing) return { status: 'missing', message: 'Configure an AI Gateway URL and API token.' };
  if (error instanceof GatewayManagementError && (error.status === 401 || error.status === 403)) {
    return { status: 'permission-denied', message: 'Management access was denied. Use a valid API token with AI Gateway Read access to this gateway. AI Gateway Run alone does not allow route inspection.' };
  }
  if (error) return { status: 'unavailable', message: 'AI Gateway route inspection is unavailable. Retry when the connection is available.' };
  return { status: 'ready', message: 'AI Gateway route inspection is available.' };
}
/**
 * Count the bytes we actually receive. Content-Length is not a safe limit.
 * Cancel oversized bodies before parsing, and keep the UTF-8 decoder state
 * between chunks so a split character survives. Each endpoint still has to
 * validate the parsed JSON against its own response shape.
 */
async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = ''; let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_MANAGEMENT_RESPONSE_BYTES) {
      await reader.cancel('management response too large');
      throw new Error('management_response_too_large');
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  try { return JSON.parse(text); } catch { throw new Error('management_response_malformed'); }
}
/**
 * Route versions can hold elements directly or inside JSON-encoded data.
 * Read the supported wrappers below and return undefined for anything else.
 * An unreadable graph is not an empty graph; callers must stop inspection.
 */
function extractElements(value: Record<string, unknown>): unknown {
  if (Array.isArray(value.data)) return value.data;
  if (typeof value.data === 'string') {
    try {
      const parsed: unknown = JSON.parse(value.data);
      if (Array.isArray(parsed)) return parsed;
      if (isPlainObject(parsed) && Array.isArray(parsed.elements)) return parsed.elements;
    } catch { return undefined; }
  }
  if (Array.isArray(value.elements)) return value.elements;
  if (isPlainObject(value.configuration) && Array.isArray(value.configuration.elements)) return value.configuration.elements;
  if (isPlainObject(value.config) && Array.isArray(value.config.elements)) return value.config.elements;
  return undefined;
}
/**
 * Find the active revision in the supported response wrappers. If the response
 * has an explicit version object, require its active flag and check it against
 * any deployment pointer. Picking the newest-looking version would be a guess.
 */
function extractVersion(value: unknown): { versionId: string; elements?: unknown } | null {
  if (!isPlainObject(value)) return null;
  const result = isPlainObject(value.result) ? value.result : value;
  const active = isPlainObject(result.version) ? result.version
    : isPlainObject(result.active_version) ? result.active_version
      : isPlainObject(result.activeVersion) ? result.activeVersion : result;
  const versionId = [active.id, active.version_id, active.versionId, result.active_version_id, result.activeVersionId]
    .find((candidate): candidate is string => safeString(candidate, 128));
  if (!versionId) return null;
  if (isPlainObject(result.version)) {
    if (active.active !== true && active.active !== 'true') return null;
    const deployedVersion = isPlainObject(result.deployment)
      ? [result.deployment.version_id, result.deployment.versionId].find((candidate): candidate is string => safeString(candidate, 128)) : undefined;
    if (deployedVersion && deployedVersion !== versionId) return null;
  }
  const elements = extractElements(active) ?? extractElements(result);
  return elements === undefined ? { versionId } : { versionId, elements };
}
/**
 * Make one management GET. There are no retries and no alternate credentials
 * or transports. Do not follow redirects: a response's Location must not decide
 * where we send the bearer token.
 *
 * Keep the timeout running until the body has been read, then clear it even on
 * failure. Reject HTTP errors and success:false without copying the response
 * payload into an error message.
 */
async function managementRequest(url: string, token: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('management request timeout'), MANAGEMENT_REQUEST_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(url, { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, redirect: 'manual', signal: controller.signal });
    } catch { throw new Error('management_transport_failure'); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new GatewayManagementError(response.status);
    }
    const payload = await readBoundedJson(response);
    if (isPlainObject(payload) && payload.success === false) throw new GatewayManagementError(response.status);
    return payload;
  } finally { clearTimeout(timeout); }
}
/**
 * Collect the complete route list and return only stable IDs and names.
 * Cloudflare documents page and per_page in the data envelope. It does not
 * require count or total_count. Do not make those fields a condition of access.
 *
 * Without totals, keep reading full pages until a short page arrives. An exactly
 * full last page needs one more read, which returns an empty page. Explicit
 * row totals can prove completion without that extra request.
 *
 * Also accept the existing unpaged result/data shape. If it includes result_info,
 * the counts must show that the entire list is present. Throw on a failed later
 * page or duplicate identity, and when a limit stops us before completion.
 */
export async function listDynamicRoutes(accountId: string, gatewayId: string, token: string): Promise<Array<{ id: string; name: string }>> {
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-gateway/gateways/${encodeURIComponent(gatewayId)}/routes`;
  const result: Array<{ id: string; name: string }> = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  let pageSize: number | undefined;
  let totalCount: number | undefined;
  let totalPages: number | undefined;
  for (let page = 1; page <= MAX_DYNAMIC_ROUTE_PAGES; page += 1) {
    // Keep the page total once we have it. A later response cannot erase it.
    // Stop before an out-of-range request rather than return an incomplete list.
    if (totalPages !== undefined && page > totalPages) throw new Error('route_list_incomplete');
    // Let Cloudflare choose the first page size, then keep using that validated
    // size. Each subsequent request reads a new page; it does not retry a failure.
    const payload = await managementRequest(page === 1 ? base : `${base}?page=${page}&per_page=${pageSize}`, token);
    if (!isPlainObject(payload)) throw new Error('route_list_malformed');
    const envelope = isPlainObject(payload.data) ? payload.data : isPlainObject(payload.result) ? payload.result : null;
    if (!envelope || !Array.isArray(envelope.routes)) throw new Error('route_list_malformed');
    const paginated = envelope.page !== undefined || envelope.per_page !== undefined;
    if (page > 1 && !paginated) throw new Error('route_list_incomplete');
    // Check metadata on both the response and its route envelope. They must
    // agree. We cannot follow cursor pagination here, so reject it rather than
    // claim the list is complete. Honor totals when supplied, but do not demand
    // them from the documented page/per_page response.
    for (const owner of [payload, envelope]) {
      if ((owner.gateway_id !== undefined && owner.gateway_id !== gatewayId)
        || owner.has_more === true || owner.hasMore === true || owner.next_cursor || owner.cursor || owner.next || owner.cursors
        || owner.pagination !== undefined) throw new Error('route_list_incomplete');
      const metadata = [
        ...(owner.result_info !== undefined ? [owner.result_info] : []),
        ...(['page', 'count', 'per_page', 'total_count', 'total_pages'].some((key) => Object.hasOwn(owner, key)) ? [owner] : []),
      ];
      for (const info of metadata) {
        // Require the page we asked for and keep the same size across pages.
        // The older unpaged shape still needs counts proving a complete list.
        if (!isPlainObject(info) || info.page !== page || !Number.isInteger(info.per_page)
          || (info.per_page as number) < 1 || (info.per_page as number) > MAX_DYNAMIC_ROUTES
          || envelope.routes.length > (info.per_page as number)
          || (pageSize !== undefined && pageSize !== info.per_page)
          || (info.count !== undefined && info.count !== envelope.routes.length)
          || (!paginated && (info.count !== envelope.routes.length || info.total_count !== envelope.routes.length))
          || info.cursor || info.next_cursor || info.next || info.cursors || info.has_more === true || info.hasMore === true) throw new Error('route_list_incomplete');
        pageSize = info.per_page as number;
        if (info.total_count !== undefined) {
          if (!Number.isInteger(info.total_count) || (info.total_count as number) < 0 || (info.total_count as number) > MAX_DYNAMIC_ROUTES
            || (totalCount !== undefined && totalCount !== info.total_count)) throw new Error('route_list_incomplete');
          totalCount = info.total_count as number;
        }
        if (info.total_pages !== undefined) {
          if (!Number.isInteger(info.total_pages) || ((info.total_pages as number) < page && !(page === 1 && info.total_pages === 0 && envelope.routes.length === 0))
            || (info.total_pages as number) > MAX_DYNAMIC_ROUTE_PAGES
            || (totalPages !== undefined && totalPages !== info.total_pages)) throw new Error('route_list_incomplete');
          totalPages = info.total_pages as number;
        }
      }
    }
    // Check IDs and names across every page. Silently deduplicating could hide
    // a skipped route, which would make cleanup unsafe. Reject duplicates and
    // any row that names a gateway other than the one we requested.
    for (const candidate of envelope.routes) {
      if (!isPlainObject(candidate) || !safeString(candidate.id, 128) || !dynamicRouteSchema.safeParse(candidate.name).success
        || ids.has(candidate.id) || names.has(candidate.name as string)
        || (candidate.gateway_id !== undefined && candidate.gateway_id !== gatewayId)) throw new Error('route_list_malformed');
      ids.add(candidate.id);
      names.add(candidate.name as string);
      result.push({ id: candidate.id, name: candidate.name as string });
    }
    // A short page ends the scan when there are no row totals. Supplied totals
    // can also prove that a full page is the last one, but all counts must agree.
    // Reaching our budget is not proof that any unread routes have disappeared.
    if (result.length > MAX_DYNAMIC_ROUTES || (totalCount !== undefined && result.length > totalCount)) throw new Error('route_list_incomplete');
    if (!paginated || envelope.routes.length < (envelope.per_page as number) || result.length === totalCount) {
      if ((totalCount !== undefined && result.length !== totalCount) || (totalPages !== undefined && totalPages > page)) throw new Error('route_list_incomplete');
      return result;
    }
  }
  throw new Error('route_list_incomplete');
}
/** Keep binding metadata only. Never include secrets, headers or destination URLs. */
export interface NativeProviderConfig {
  id: string;
  provider: string;
  gatewayId: string;
  alias?: string;
  defaultSelection: boolean;
}

// Accept boolean flags and numeric 0/1 only. The string "false" is truthy in
// JavaScript; treating it as a flag could select the wrong default provider.
function parseDefaultConfig(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  throw new Error('provider_config_list_malformed');
}

/**
 * Read Native provider bindings for this gateway and leave out sensitive fields.
 * This endpoint uses result_info with explicit counts, unlike Dynamic Routing.
 * Keep the page size and total count consistent, check any page total, and reject
 * repeated binding IDs. A failed scan must not return the bindings read so far.
 */
export async function listNativeProviderConfigs(accountId: string, gatewayId: string, token: string): Promise<NativeProviderConfig[]> {
  const result: NativeProviderConfig[] = [];
  const ids = new Set<string>();
  let total: number | undefined;
  let pageSize: number | undefined;
  let totalPages: number | undefined;
  for (let page = 1; page <= MAX_PROVIDER_CONFIG_PAGES; page += 1) {
    const payload = await managementRequest(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-gateway/gateways/${encodeURIComponent(gatewayId)}/provider_configs?page=${page}&per_page=100`, token);
    if (!isPlainObject(payload) || payload.success !== true || !Array.isArray(payload.result) || !isPlainObject(payload.result_info)) throw new Error('provider_config_list_malformed');
    // Use this endpoint's totals to decide when we are done. A short page alone
    // is not enough. Reject conflicting metadata and cursor pagination; check
    // each binding's gateway below.
    const info = payload.result_info;
    if (info.page !== page || !Number.isInteger(info.count) || !Number.isInteger(info.per_page) || !Number.isInteger(info.total_count)
      || info.count !== payload.result.length || (info.per_page as number) < 1 || (info.per_page as number) > 100
      || (info.total_count as number) < 0 || (info.total_count as number) > MAX_PROVIDER_CONFIGS
      || payload.result.length > (info.per_page as number)
      || (total !== undefined && total !== info.total_count) || (pageSize !== undefined && pageSize !== info.per_page)
      || (info.total_pages !== undefined && !(page === 1 && info.total_count === 0 && info.total_pages === 0)
        && (!Number.isInteger(info.total_pages) || (info.total_pages as number) < page
          || (info.total_pages as number) > MAX_PROVIDER_CONFIG_PAGES))
      || (page > 1 && totalPages !== info.total_pages)
      || info.has_more === true || info.hasMore === true || info.cursor || info.next_cursor || info.cursors
      || payload.has_more === true || payload.hasMore === true || payload.cursor || payload.next_cursor || payload.cursors) throw new Error('provider_config_list_malformed');
    total = info.total_count as number;
    pageSize = info.per_page as number;
    totalPages = info.total_pages === 0 ? 1 : info.total_pages as number | undefined;
    for (const candidate of payload.result) {
      if (!isPlainObject(candidate) || !safeString(candidate.id, 128) || !providerSlugSchema.safeParse(candidate.provider_slug).success
        || !providerAliasSchema.optional().safeParse(candidate.alias).success || candidate.gateway_id !== gatewayId
        || ids.has(candidate.id)) throw new Error('provider_config_list_malformed');
      ids.add(candidate.id);
      result.push({ id: candidate.id, provider: candidate.provider_slug as string, gatewayId,
        ...(typeof candidate.alias === 'string' && { alias: candidate.alias }), defaultSelection: parseDefaultConfig(candidate.default_config) });
    }
    if (result.length > total || (totalPages === page && result.length !== total)) throw new Error('provider_config_list_malformed');
    if (result.length === total) {
      if (totalPages !== undefined && totalPages !== page) throw new Error('provider_config_list_malformed');
      return result;
    }
    if (payload.result.length === 0) throw new Error('provider_config_list_malformed');
  }
  throw new Error('provider_config_list_malformed');
}

/**
 * Use the one binding marked default. With no default, a single candidate is
 * also safe to select. Throw when either choice is ambiguous; list order is
 * not an administrator's preference. Return null when there are no candidates.
 */
export function selectNativeProviderConfig(configs: NativeProviderConfig[], provider: string): NativeProviderConfig | null {
  providerSlugSchema.parse(provider);
  const candidates = configs.filter((config) => config.provider === provider);
  const defaults = candidates.filter((config) => config.defaultSelection);
  if (defaults.length > 1 || (defaults.length === 0 && candidates.length > 1)) throw new Error('provider_config_ambiguous');
  return defaults[0] ?? candidates[0] ?? null;
}

/** Keep the Bedrock entry point, using the same selection rule as other providers. */
export function defaultBedrockProvider(configs: NativeProviderConfig[]): NativeProviderConfig | null {
  return selectNativeProviderConfig(configs, 'aws-bedrock');
}

/**
 * Look up custom-provider slugs across the account so callers can classify them.
 * Discard base URLs, headers, names and examples. Collect unique slugs within
 * the scan limits until their count reaches the reported total.
 *
 * These are account-level provider names. Do not use them as IDs for Native
 * bindings on a particular gateway.
 */
export async function listCustomProviderSlugs(accountId: string, token: string): Promise<Set<string>> {
  const result = new Set<string>();
  for (let page = 1; page <= MAX_PROVIDER_CONFIG_PAGES; page += 1) {
    const payload = await managementRequest(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-gateway/custom-providers?page=${page}&per_page=100`, token);
    if (!isPlainObject(payload) || payload.success !== true || !Array.isArray(payload.result) || !isPlainObject(payload.result_info)) throw new Error('custom_provider_list_malformed');
    const info = payload.result_info;
    if (info.page !== page || !Number.isInteger(info.count) || !Number.isInteger(info.per_page) || !Number.isInteger(info.total_count)
      || info.count !== payload.result.length || (info.per_page as number) < 1 || (info.per_page as number) > 100
      || (info.total_count as number) < 0 || (info.total_count as number) > MAX_PROVIDER_CONFIGS) throw new Error('custom_provider_list_malformed');
    for (const candidate of payload.result) {
      if (!isPlainObject(candidate) || !providerSlugSchema.safeParse(candidate.slug).success) throw new Error('custom_provider_list_malformed');
      result.add(candidate.slug as string);
    }
    if (result.size >= (info.total_count as number)) return result;
    if (payload.result.length === 0) throw new Error('custom_provider_list_malformed');
  }
  throw new Error('custom_provider_list_malformed');
}

/**
 * If the custom-provider lookup fails, we can still recognize the known built-in
 * slugs. Any unknown slug needs that lookup to succeed. Otherwise we could call
 * a custom provider Native without evidence.
 *
 * This exception only handles classification. It neither changes credentials
 * nor creates a provider binding.
 */
export async function listCustomProviderSlugsForProviders(
  accountId: string,
  token: string,
  providers: Iterable<string>,
): Promise<Set<string>> {
  const requested = [...providers];
  try {
    return await listCustomProviderSlugs(accountId, token);
  } catch (error) {
    if (requested.every((provider) => KNOWN_NATIVE_PROVIDERS.has(provider))) return new Set();
    throw error;
  }
}

/**
 * Look up the route name in the complete current inventory, then fetch its
 * details by the returned stable ID. Use the same account and gateway for both
 * requests. Return the active revision with its readable graph, or throw if the
 * route is missing or its active details cannot be read. Do not guess backends.
 */
export async function loadActiveRouteVersion(accountId: string, gatewayId: string, route: string, token: string): Promise<{ versionId: string; elements: unknown }> {
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-gateway/gateways/${encodeURIComponent(gatewayId)}/routes`;
  const listed = (await listDynamicRoutes(accountId, gatewayId, token)).find((candidate) => candidate.name === route);
  if (!listed) throw new Error('route_not_found');
  const active = extractVersion(await managementRequest(`${base}/${encodeURIComponent(listed.id)}`, token));
  if (!active || active.elements === undefined) throw new Error('active_version_malformed');
  return { versionId: active.versionId, elements: active.elements };
}
