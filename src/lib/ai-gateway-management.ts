/**
 * Read-only Cloudflare AI Gateway management boundary.
 *
 * Callers resolve saved or draft connection coordinates before invoking these
 * readers. Requests target the Cloudflare management API, never a URL returned
 * by an upstream payload. This module does not change gateways, routes, provider
 * credentials, or saved application settings.
 *
 * Dynamic Routing uses a data.routes/page/per_page envelope; provider bindings
 * use result/result_info. Their completion rules are deliberately separate.
 * A failed inventory must throw rather than return accumulated rows: downstream
 * reconciliation treats a successful complete list as authority for absence.
 * Relevant SDK contract:
 * https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/ai-gateway/dynamic-routing.ts
 */
import { z } from 'zod';
import type { Env } from '../types';
import { getAigConfig } from './aig-config';

// The byte and timeout limits apply to each request, including body consumption.
// Inventory limits bound sequential reads; they are application safety budgets,
// not claims about Cloudflare account quotas or endpoint maximums.
const MAX_MANAGEMENT_RESPONSE_BYTES = 1024 * 1024;
const MANAGEMENT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_PROVIDER_CONFIG_PAGES = 10;
const MAX_PROVIDER_CONFIGS = 1000;
const MAX_DYNAMIC_ROUTE_PAGES = 10;
const MAX_DYNAMIC_ROUTES = 1000;
// Only these built-in slugs may proceed when custom-provider classification is
// unavailable. This set is not a model-version or provider-config allowlist.
const KNOWN_NATIVE_PROVIDERS = new Set(['aws-bedrock', 'google-ai-studio', 'openai']);
const providerSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const providerAliasSchema = z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/);
// Route names also become dictionary keys in routing configuration. Exclude
// prototype-sensitive keys as well as path separators and control characters.
export const dynamicRouteSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
  .refine((value) => !['__proto__', 'prototype', 'constructor'].includes(value.toLowerCase()));
// A draft is an inspection overlay, not permission to persist a connection.
// Account API URLs contain no gateway name, so that form needs an explicit ID.
export const gatewayDraftSchema = z.object({
  gatewayUrl: z.string().trim().max(512).refine((value) => parseGatewayUrl(value) !== null),
  gatewayId: dynamicRouteSchema.optional(),
  replacementToken: z.string().trim().max(2048).regex(/^[^\u0000-\u001f\u007f]*$/).optional(),
}).strict().superRefine((value, context) => {
  if (parseGatewayUrl(value.gatewayUrl)?.kind === 'account-api' && !value.gatewayId) {
    context.addIssue({ code: 'custom', message: 'AI Gateway name is required for an account API URL', path: ['gatewayId'] });
  }
});
// Administrator-authored descriptions are bounded display metadata. They do not
// identify a backend authoritatively or override the gateway's route topology.
export const backendDescriptionsSchema = z.record(
  z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).refine((value) => !['__proto__', 'prototype', 'constructor'].includes(value.toLowerCase())),
  z.string().trim().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/),
).refine((value) => Object.keys(value).length <= 256);
export type GatewayDraft = z.infer<typeof gatewayDraftSchema>;
export interface GatewayConnection { gatewayUrl?: string; gatewayId?: string; token?: string }
export interface ParsedGatewayUrl { accountId: string; gatewayId?: string; kind: 'legacy' | 'account-api'; canonicalUrl: string }
export interface ConnectionStatus { status: 'ready' | 'missing' | 'permission-denied' | 'unavailable'; message: string }

// JSON boundaries remain unknown until narrowed. These helpers check object
// shape and bounded, nonempty strings; endpoint-specific schemas follow below.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function safeString(value: unknown, maxLength = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value);
}
/**
 * Accept only supported HTTPS Cloudflare URL shapes and extract coordinates.
 * Embedded credentials and non-default ports are rejected. Legacy gateway URLs
 * carry both IDs and reject query/fragment suffixes; account API forms retain
 * only the account root, discarding inference-path/query/fragment details.
 * Management readers reconstruct their own fixed-origin URLs from those IDs.
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
/** A gateway embedded in a legacy URL takes precedence over a separate draft ID. */
export function gatewayCoordinates(connection: GatewayConnection): { accountId: string; gatewayId: string } | null {
  const parsed = parseGatewayUrl(connection.gatewayUrl);
  if (!parsed) return null;
  const gatewayId = parsed.gatewayId ?? connection.gatewayId;
  return gatewayId && dynamicRouteSchema.safeParse(gatewayId).success ? { accountId: parsed.accountId, gatewayId } : null;
}
/**
 * Overlay validated draft values on the saved connection without writing them.
 * getAigConfig remains the sole owner of credential decryption and precedence;
 * an omitted or blank replacement token keeps the saved token. A legacy URL
 * owns its gateway name, while account API URLs use the separate gateway ID.
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
// Keep only HTTP status across the management boundary, not response bodies,
// Authorization headers, or provider configuration details.
class GatewayManagementError extends Error {
  constructor(public readonly status: number) { super('management_request_failed'); }
}
/**
 * Only an actual management HTTP 401/403 is classified as permission denial.
 * Transport, payload, and completeness errors are unavailable, not evidence
 * that saved credentials were lost. Management Read and inference Run access
 * are distinct; successful inference alone does not prove inspection access.
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
 * Count streamed bytes rather than trusting Content-Length. Cancel oversized
 * bodies before JSON parsing, and decode UTF-8 incrementally across chunks.
 * Syntax-valid JSON is still unknown until each endpoint validates its shape.
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
 * Normalize the supported route-version element representations, including
 * JSON-encoded data. Return undefined for unknown shapes rather than inventing
 * an empty backend graph; a route with no readable graph cannot be inspected.
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
 * Resolve the active revision from supported response wrappers. An explicit
 * version object must be marked active and agree with any deployment pointer.
 * Do not guess a revision from version ordering or silently use another graph.
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
 * Perform one bounded management GET, with no retry or token/transport fallback.
 * Redirects are not followed, preventing bearer credentials from being forwarded
 * to a Location supplied by the response. The abort timer covers fetching and
 * body consumption and is cleared on every exit. HTTP and success:false errors
 * propagate without including the upstream payload in the error message.
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
 * Return a complete route inventory, projecting only stable IDs and route names.
 * Cloudflare's documented data envelope supplies page and per_page, but does
 * not require count or total_count. Without totals, full pages require another
 * read; a short page, including an empty page after an exactly full page, ends
 * the scan. Explicit totals can instead prove that a full last page is complete.
 *
 * Retain the existing unpaged result/data compatibility shape. When that shape
 * advertises result_info, its counts must prove the entire list is present.
 * No partial result escapes on later-page failure, duplicates, or limit expiry.
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
    // An advertised page total remains binding even if later responses omit it.
    // Reject before requesting beyond that boundary; do not return partial rows.
    if (totalPages !== undefined && page > totalPages) throw new Error('route_list_incomplete');
    // Preserve the first request's default page size, then reuse the validated
    // size reported by Cloudflare. These are page reads, not request retries.
    const payload = await managementRequest(page === 1 ? base : `${base}?page=${page}&per_page=${pageSize}`, token);
    if (!isPlainObject(payload)) throw new Error('route_list_malformed');
    const envelope = isPlainObject(payload.data) ? payload.data : isPlainObject(payload.result) ? payload.result : null;
    if (!envelope || !Array.isArray(envelope.routes)) throw new Error('route_list_malformed');
    const paginated = envelope.page !== undefined || envelope.per_page !== undefined;
    if (page > 1 && !paginated) throw new Error('route_list_incomplete');
    // Inspect both outer and inner metadata; neither may contradict the other.
    // Cursor-style continuation is unsupported and therefore fails closed.
    // Optional totals constrain completion, but their absence is not an error
    // for the documented page/per_page envelope.
    for (const owner of [payload, envelope]) {
      if ((owner.gateway_id !== undefined && owner.gateway_id !== gatewayId)
        || owner.has_more === true || owner.hasMore === true || owner.next_cursor || owner.cursor || owner.next || owner.cursors
        || owner.pagination !== undefined) throw new Error('route_list_incomplete');
      const metadata = [
        ...(owner.result_info !== undefined ? [owner.result_info] : []),
        ...(['page', 'count', 'per_page', 'total_count', 'total_pages'].some((key) => Object.hasOwn(owner, key)) ? [owner] : []),
      ];
      for (const info of metadata) {
        // Page numbers must advance exactly and page size must remain stable.
        // The older unpaged metadata shape retains its complete-count proof.
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
    // Identity sets span the whole scan. A duplicate could mask a skipped row
    // during pagination, so it invalidates the inventory rather than deduping.
    // Any explicitly supplied gateway binding must match the requested gateway.
    for (const candidate of envelope.routes) {
      if (!isPlainObject(candidate) || !safeString(candidate.id, 128) || !dynamicRouteSchema.safeParse(candidate.name).success
        || ids.has(candidate.id) || names.has(candidate.name as string)
        || (candidate.gateway_id !== undefined && candidate.gateway_id !== gatewayId)) throw new Error('route_list_malformed');
      ids.add(candidate.id);
      names.add(candidate.name as string);
      result.push({ id: candidate.id, name: candidate.name as string });
    }
    // A short page establishes the count-free endpoint's terminal boundary.
    // Retain total-proven completion when counts are explicitly supplied,
    // including a full last page. Contradictory page totals still fail closed.
    // Exhausted budgets never authorize empty or truncated saved-route cleanup.
    if (result.length > MAX_DYNAMIC_ROUTES || (totalCount !== undefined && result.length > totalCount)) throw new Error('route_list_incomplete');
    if (!paginated || envelope.routes.length < (envelope.per_page as number) || result.length === totalCount) {
      if ((totalCount !== undefined && result.length !== totalCount) || (totalPages !== undefined && totalPages > page)) throw new Error('route_list_incomplete');
      return result;
    }
  }
  throw new Error('route_list_incomplete');
}
/** Safe binding projection: no provider secret, header, or destination URL. */
export interface NativeProviderConfig {
  id: string;
  provider: string;
  gatewayId: string;
  alias?: string;
  defaultSelection: boolean;
}

// Normalize only explicit boolean/numeric flags. Truthiness would turn a
// string such as "false" into an unintended default provider selection.
function parseDefaultConfig(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  throw new Error('provider_config_list_malformed');
}

/**
 * Read gateway-scoped Native provider bindings, discarding sensitive fields.
 * Unlike Dynamic Routing, this endpoint uses result_info with explicit counts.
 * Page size, total count, optional page total, and unique binding IDs must stay
 * coherent across the scan. Failure never returns a partial binding inventory.
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
    // This endpoint's explicit totals, not a short-page heuristic, determine
    // completion. Reject drift, unsupported cursors, and foreign bindings.
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
 * Select an explicit sole default, otherwise a sole available binding.
 * Multiple defaults or multiple non-default candidates are ambiguous: never
 * choose by list order. No candidate is represented as null, not a guessed ID.
 */
export function selectNativeProviderConfig(configs: NativeProviderConfig[], provider: string): NativeProviderConfig | null {
  providerSlugSchema.parse(provider);
  const candidates = configs.filter((config) => config.provider === provider);
  const defaults = candidates.filter((config) => config.defaultSelection);
  if (defaults.length > 1 || (defaults.length === 0 && candidates.length > 1)) throw new Error('provider_config_ambiguous');
  return defaults[0] ?? candidates[0] ?? null;
}

/** Preserve the established Bedrock helper while using the generic selection rule. */
export function defaultBedrockProvider(configs: NativeProviderConfig[]): NativeProviderConfig | null {
  return selectNativeProviderConfig(configs, 'aws-bedrock');
}

/**
 * Read the account-scoped custom-provider namespace for classification.
 * Only slugs survive; base URLs, headers, names, and examples are discarded.
 * The bounded scan collects unique slugs until the reported total is reached.
 * These account-level names are not gateway-scoped Native binding identities.
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
 * Classification failure is tolerable only when every requested slug is a
 * known built-in provider. Unknown slugs require the custom-provider inventory;
 * failure there must not silently classify a custom provider as Native.
 * This exception does not substitute credentials or create provider bindings.
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
 * Resolve a route name through the complete current inventory, then fetch its
 * detail by the returned stable ID. Both requests stay scoped to the same
 * account and gateway. Return only the active revision and readable graph;
 * absent routes or malformed active details cannot produce inferred backends.
 */
export async function loadActiveRouteVersion(accountId: string, gatewayId: string, route: string, token: string): Promise<{ versionId: string; elements: unknown }> {
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-gateway/gateways/${encodeURIComponent(gatewayId)}/routes`;
  const listed = (await listDynamicRoutes(accountId, gatewayId, token)).find((candidate) => candidate.name === route);
  if (!listed) throw new Error('route_not_found');
  const active = extractVersion(await managementRequest(`${base}/${encodeURIComponent(listed.id)}`, token));
  if (!active || active.elements === undefined) throw new Error('active_version_malformed');
  return { versionId: active.versionId, elements: active.elements };
}
