import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../../types';
import { authMiddleware, requireAdmin, type AuthVariables } from '../../middleware/auth';
import { createRateLimiter } from '../../middleware/rate-limit';
import { getAigConfig } from '../../lib/aig-config';
import { SETUP_KEYS } from '../../lib/kv-keys';
import { createLogger } from '../../lib/logger';
import { parseReasoningConfiguration } from '../../lib/reasoning-configuration';
import * as profileCatalog from '../../lib/reasoning-profiles';
import { discoverPiCompatibility } from '../../lib/reasoning-discovery';
import {
  DynamicRouteInventoryError,
  deriveCommonMapping,
  inventoryDynamicRoute,
  type DynamicRouteInventory,
  type LegMappingEvidence,
} from '../../lib/dynamic-route-inventory';

const MAX_MANAGEMENT_RESPONSE_BYTES = 1024 * 1024;
const MANAGEMENT_REQUEST_TIMEOUT_MS = 10_000;
const logger = createLogger('admin-reasoning');

const routeSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const profileRefSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  revision: z.number().int().positive(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const discoverySchema = z.object({
  route: routeSchema,
  profileRef: profileRefSchema,
  maxCompletionTokens: z.number().int().min(32).max(16_384).default(32),
}).strict();

type ProfileRef = z.infer<typeof profileRefSchema>;

interface ReasoningConfigurationView {
  customProfileRevisions: Record<string, unknown>[];
  routeAssignments: Record<string, Record<string, unknown>>;
}

interface ProfileModuleShape {
  BUILT_IN_REASONING_PROFILES?: readonly Record<string, unknown>[];
  COMPATIBILITY_NOTICES?: readonly Record<string, unknown>[];
}

const catalogModule = profileCatalog as unknown as ProfileModuleShape;

const discoveryRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 5,
  keyPrefix: 'admin-reasoning-discovery',
  failClosed: true,
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value: unknown, maxLength = 512): value is string {
  return typeof value === 'string'
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value);
}

async function readReasoningConfiguration(kv: KVNamespace): Promise<ReasoningConfigurationView> {
  const raw = await kv.get(SETUP_KEYS.REASONING_CONFIGURATION);
  if (!raw) return { customProfileRevisions: [], routeAssignments: {} };
  const parsed = parseReasoningConfiguration(raw);
  return {
    customProfileRevisions: parsed.customProfileRevisions as unknown as Record<string, unknown>[],
    routeAssignments: parsed.routeAssignments as unknown as Record<string, Record<string, unknown>>,
  };
}

function sanitizeProvenance(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  const result: Record<string, unknown> = {};
  for (const key of ['provider', 'modelId', 'route', 'activeRouteVersion', 'routeRevisionLabel', 'routeModel', 'observedAt', 'evidenceType', 'source']) {
    if (safeString(value[key])) result[key] = value[key];
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function sanitizeEvidenceSummary(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  const result: Record<string, unknown> = {};
  for (const key of ['modelId', 'provider', 'route', 'routeVersion', 'observedAt', 'classification', 'evidenceType', 'digest', 'status', 'ingress', 'canaryVersion']) {
    if (safeString(value[key])) result[key] = value[key];
  }
  for (const key of ['current', 'toolReplay']) {
    if (typeof value[key] === 'boolean') result[key] = value[key];
  }
  if (Array.isArray(value.validatedTransports)) {
    result.validatedTransports = value.validatedTransports.filter((item) => safeString(item, 32)).slice(0, 2);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function sanitizeProfile(profile: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ['id', 'name', 'description', 'family', 'schemaVersion', 'revision', 'hash', 'enabled', 'ingressContract', 'supportedLevels', 'unsupportedLevels', 'removePaths', 'levels', 'aliases', 'offSemantics', 'toolCompatibility', 'recognizedResponseFields', 'validatedTransports', 'classification', 'limitations']) {
    if (profile[key] !== undefined) result[key] = profile[key];
  }
  const originallyCreatedAgainst = sanitizeProvenance(profile.originallyCreatedAgainst);
  if (originallyCreatedAgainst) result.originallyCreatedAgainst = originallyCreatedAgainst;
  if (Array.isArray(profile.validatedAgainst)) {
    result.validatedAgainst = profile.validatedAgainst
      .slice(0, 20)
      .map(sanitizeEvidenceSummary)
      .filter((item): item is Record<string, unknown> => item !== undefined);
  }
  if (Array.isArray(profile.evidence)) {
    result.evidence = profile.evidence
      .slice(0, 20)
      .map(sanitizeEvidenceSummary)
      .filter((item): item is Record<string, unknown> => item !== undefined);
  }
  return result;
}

function sanitizeNotice(notice: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { assignable: false };
  for (const key of ['id', 'name', 'title', 'summary', 'classification', 'limitations']) {
    if (notice[key] !== undefined) result[key] = notice[key];
  }
  return result;
}

function parseProfileRef(value: unknown): ProfileRef | null {
  const parsed = profileRefSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function sameProfileRef(left: ProfileRef, right: ProfileRef): boolean {
  return left.id === right.id && left.revision === right.revision && left.hash === right.hash;
}

function profileRefFor(profile: Record<string, unknown>): ProfileRef | null {
  return parseProfileRef({ id: profile.id, revision: profile.revision, hash: profile.hash });
}

function allProfiles(configuration: ReasoningConfigurationView): Record<string, unknown>[] {
  return [...(catalogModule.BUILT_IN_REASONING_PROFILES ?? []), ...configuration.customProfileRevisions];
}

function resolveProfile(configuration: ReasoningConfigurationView, requested: ProfileRef): Record<string, unknown> | null {
  return allProfiles(configuration).find((profile) => {
    const reference = profileRefFor(profile);
    return reference !== null && sameProfileRef(reference, requested) && profile.enabled !== false;
  }) ?? null;
}

function assignmentUsage(configuration: ReasoningConfigurationView): Array<{ profileRef: ProfileRef; routes: string[] }> {
  const grouped = new Map<string, { profileRef: ProfileRef; routes: string[] }>();
  for (const [route, assignment] of Object.entries(configuration.routeAssignments)) {
    const profileRef = parseProfileRef(assignment.activeProfile);
    if (!profileRef) continue;
    const key = JSON.stringify(profileRef);
    const current = grouped.get(key) ?? { profileRef, routes: [] };
    current.routes.push(route);
    grouped.set(key, current);
  }
  return [...grouped.values()].map((item) => ({ ...item, routes: item.routes.sort() }));
}

function parseGatewayUrl(raw: string | undefined): { accountId: string; gatewayId: string } | null {
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'gateway.ai.cloudflare.com') return null;
  const match = /^\/v1\/([a-f0-9]{32})\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?:\/|$)/i.exec(url.pathname);
  return match ? { accountId: match[1], gatewayId: match[2] } : null;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
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

function extractElements(value: Record<string, unknown>): unknown {
  if (Array.isArray(value.data)) return value.data;
  if (Array.isArray(value.elements)) return value.elements;
  if (isPlainObject(value.configuration) && Array.isArray(value.configuration.elements)) return value.configuration.elements;
  if (isPlainObject(value.config) && Array.isArray(value.config.elements)) return value.config.elements;
  return undefined;
}

function extractVersion(value: unknown): { versionId: string; elements: unknown } | { versionId: string } | null {
  if (!isPlainObject(value)) return null;
  const result = isPlainObject(value.result) ? value.result : value;
  const active = isPlainObject(result.version)
    ? result.version
    : isPlainObject(result.active_version)
      ? result.active_version
      : isPlainObject(result.activeVersion)
        ? result.activeVersion
        : result;
  const versionId = [active.id, active.version_id, active.versionId, result.active_version_id, result.activeVersionId]
    .find((candidate): candidate is string => safeString(candidate, 128));
  if (!versionId) return null;
  if (isPlainObject(result.version)) {
    if (active.active !== true) return null;
    const deployedVersion = isPlainObject(result.deployment)
      ? [result.deployment.version_id, result.deployment.versionId].find((candidate): candidate is string => safeString(candidate, 128))
      : undefined;
    if (deployedVersion && deployedVersion !== versionId) return null;
  }
  const elements = extractElements(active);
  return elements === undefined ? { versionId } : { versionId, elements };
}

async function managementRequest(url: string, token: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('management request timeout'), MANAGEMENT_REQUEST_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch {
      throw new Error('management_transport_failure');
    }
    const payload = await readBoundedJson(response);
    if (!response.ok || (isPlainObject(payload) && payload.success === false)) throw new Error('management_request_failed');
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function listDynamicRoutes(accountId: string, gatewayId: string, token: string): Promise<Array<{ id: string; name: string }>> {
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-gateway/gateways/${encodeURIComponent(gatewayId)}/routes`;
  const payload = await managementRequest(base, token);
  if (!isPlainObject(payload) || !isPlainObject(payload.data) || !Array.isArray(payload.data.routes)) throw new Error('route_list_malformed');
  return payload.data.routes.map((candidate) => {
    if (!isPlainObject(candidate) || !safeString(candidate.id, 128) || !routeSchema.safeParse(candidate.name).success) {
      throw new Error('route_list_malformed');
    }
    return { id: candidate.id, name: candidate.name as string };
  });
}

async function loadActiveRouteVersion(accountId: string, gatewayId: string, route: string, token: string): Promise<{ versionId: string; elements: unknown }> {
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-gateway/gateways/${encodeURIComponent(gatewayId)}/routes`;
  const listed = (await listDynamicRoutes(accountId, gatewayId, token)).find((candidate) => candidate.name === route);
  if (!listed) throw new Error('route_not_found');
  const routePayload = await managementRequest(`${base}/${encodeURIComponent(listed.id)}`, token);
  const active = extractVersion(routePayload);
  if (!active || !('elements' in active)) throw new Error('active_version_malformed');
  return active;
}

function assignmentLegs(assignment: Record<string, unknown> | undefined): Record<string, unknown>[] {
  return assignment && Array.isArray(assignment.legs) ? assignment.legs.filter(isPlainObject) : [];
}

function buildInventoryResponse(
  route: string,
  inventory: DynamicRouteInventory,
  assignment: Record<string, unknown> | undefined,
  configuration: ReasoningConfigurationView,
): Record<string, unknown> {
  const storedLegs = assignmentLegs(assignment);
  const currentVersion = typeof assignment?.routeVersion === 'string' && assignment.routeVersion === inventory.versionId;
  const legs = inventory.models.map((model) => {
    const stored = storedLegs.find((candidate) => candidate.nodeId === model.nodeId);
    const result: Record<string, unknown> = {
      nodeId: model.nodeId,
      provider: model.provider,
      declaredModel: model.model,
    };
    const customProviderBackend = stored?.customProviderBackend;
    if (model.provider.toLowerCase().startsWith('custom') && safeString(customProviderBackend, 256)) {
      result.customProviderBackend = customProviderBackend;
      result.provenance = 'administrator-declared';
    }
    const storedRef = parseProfileRef(stored?.profileRef);
    if (storedRef) result.profileRef = storedRef;
    const evidence = sanitizeEvidenceSummary(stored?.evidence);
    if (evidence) result.evidence = currentVersion ? evidence : { ...evidence, current: false, status: 'stale' };
    return result;
  });
  const mappingLegs: LegMappingEvidence[] = legs.map((leg) => {
    const ref = parseProfileRef(leg.profileRef);
    const profile = ref ? resolveProfile(configuration, ref) : null;
    const levels: LegMappingEvidence['levels'] = {};
    if (profile && isPlainObject(profile.levels) && Array.isArray(profile.removePaths)) {
      for (const level of Array.isArray(profile.supportedLevels) ? profile.supportedLevels : []) {
        if (!profileCatalog.isPiReasoningLevel(level) || !Array.isArray(profile.levels[level])) continue;
        levels[level] = {
          removePaths: [...profile.removePaths] as string[],
          writes: (profile.levels[level] as Array<Record<string, unknown>>).map((write) => ({
            path: String(write.path),
            value: write.value as string | number | boolean | null,
          })),
        };
      }
    }
    return {
      nodeId: String(leg.nodeId),
      ...(isPlainObject(leg.evidence) && { evidence: {
        ...(typeof leg.evidence.current === 'boolean' && { current: leg.evidence.current }),
        ...(typeof leg.evidence.toolReplay === 'boolean' && { toolReplay: leg.evidence.toolReplay }),
        ...(typeof leg.evidence.ingress === 'string' && { ingress: leg.evidence.ingress }),
      } }),
      levels,
    };
  });
  const common = deriveCommonMapping(mappingLegs);
  const warnings = [
    ...(!currentVersion && assignment?.routeVersion ? ['stale_route_inventory'] : []),
    ...common.warnings,
  ];
  return {
    schemaVersion: 1,
    route,
    routeVersion: inventory.versionId,
    legs,
    paths: inventory.paths,
    commonLevels: Object.keys(common.levels),
    ...(Object.keys(common.levels).length > 0 && { commonMapping: { levels: common.levels, digest: profileCatalog.canonicalHash(common.levels) } }),
    warnings: [...new Set(warnings)],
  };
}

export const reasoningRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
reasoningRoutes.use('*', authMiddleware);

reasoningRoutes.get('/catalog', requireAdmin, async (c) => {
  let configuration: ReasoningConfigurationView;
  try { configuration = await readReasoningConfiguration(c.env.KV); } catch {
    return c.json({ error: 'Reasoning configuration unavailable', code: 'reasoning_configuration_unavailable' }, 503);
  }
  let routes: string[] = [];
  let routeCatalogStatus: 'ready' | 'unavailable' = 'unavailable';
  const gateway = await getAigConfig(c.env);
  const parsedGateway = parseGatewayUrl(gateway.gatewayUrl);
  if (parsedGateway && gateway.token) {
    try {
      routes = (await listDynamicRoutes(parsedGateway.accountId, parsedGateway.gatewayId, gateway.token)).map((route) => route.name);
      routeCatalogStatus = 'ready';
    } catch {
      logger.warn('Dynamic route catalog discovery failed');
    }
  }
  return c.json({
    schemaVersion: 1,
    profiles: allProfiles(configuration).map(sanitizeProfile),
    notices: (catalogModule.COMPATIBILITY_NOTICES ?? []).map(sanitizeNotice),
    usage: assignmentUsage(configuration),
    routes,
    routeCatalogStatus,
  });
});

reasoningRoutes.get('/routes/:route/inventory', requireAdmin, async (c) => {
  const routeResult = routeSchema.safeParse(c.req.param('route'));
  if (!routeResult.success) return c.json({ error: 'Dynamic route not found', code: 'not_found' }, 404);
  const gateway = await getAigConfig(c.env);
  const parsedGateway = parseGatewayUrl(gateway.gatewayUrl);
  if (!parsedGateway || !gateway.token) {
    return c.json({ error: 'AI Gateway credentials unavailable', code: 'gateway_unavailable' }, 503);
  }
  try {
    const [activeVersion, configuration] = await Promise.all([
      loadActiveRouteVersion(parsedGateway.accountId, parsedGateway.gatewayId, routeResult.data, gateway.token),
      readReasoningConfiguration(c.env.KV),
    ]);
    const inventory = inventoryDynamicRoute(activeVersion);
    return c.json(buildInventoryResponse(routeResult.data, inventory, configuration.routeAssignments[routeResult.data], configuration));
  } catch (error) {
    if (error instanceof Error && error.message === 'route_not_found') {
      return c.json({ error: 'Dynamic route not found', code: 'not_found' }, 404);
    }
    logger.warn('Dynamic route inventory failed', {
      route: routeResult.data,
      code: error instanceof DynamicRouteInventoryError ? error.code : 'management_failure',
    });
    return c.json({ error: 'Dynamic route inventory unavailable', code: 'inventory_unavailable' }, 502);
  }
});

reasoningRoutes.post('/discover', requireAdmin, discoveryRateLimiter, async (c) => {
  let payload: unknown;
  try { payload = await c.req.json(); } catch {
    return c.json({ error: 'Invalid discovery request', code: 'validation_error' }, 400);
  }
  const request = discoverySchema.safeParse(payload);
  if (!request.success) return c.json({ error: 'Invalid discovery request', code: 'validation_error' }, 400);
  let configuration: ReasoningConfigurationView;
  try { configuration = await readReasoningConfiguration(c.env.KV); } catch {
    return c.json({ error: 'Reasoning configuration unavailable', code: 'reasoning_configuration_unavailable' }, 503);
  }
  const profile = resolveProfile(configuration, request.data.profileRef);
  if (!profile) return c.json({ error: 'Reasoning profile revision not found', code: 'not_found' }, 404);

  const gateway = await getAigConfig(c.env);
  const parsedGateway = parseGatewayUrl(gateway.gatewayUrl);
  if (!parsedGateway || !gateway.token) {
    return c.json({ error: 'AI Gateway credentials unavailable', code: 'gateway_unavailable' }, 503);
  }

  try {
    const routes = await listDynamicRoutes(parsedGateway.accountId, parsedGateway.gatewayId, gateway.token);
    if (!routes.some((route) => route.name === request.data.route)) {
      return c.json({ error: 'Dynamic route not found', code: 'not_found' }, 404);
    }
    const report = await discoverPiCompatibility({
      accountId: parsedGateway.accountId,
      gatewayId: parsedGateway.gatewayId,
      apiToken: gateway.token,
      route: `dynamic/${request.data.route}`,
      profile,
      maxCompletionTokens: request.data.maxCompletionTokens,
    });
    logger.info('Reasoning discovery completed', {
      initiatedBy: c.get('user')?.email ?? 'unknown',
      route: request.data.route,
      profileId: request.data.profileRef.id,
      classification: report.classification,
      logicalProbes: report.accounting.logicalProbes,
      httpAttempts: report.accounting.httpAttempts,
    });
    return c.json(report);
  } catch {
    logger.warn('Reasoning discovery failed', {
      route: request.data.route,
      profileId: request.data.profileRef.id,
      initiatedBy: c.get('user')?.email ?? 'unknown',
    });
    return c.json({ error: 'Reasoning discovery unavailable', code: 'discovery_unavailable' }, 502);
  }
});

export default reasoningRoutes;
