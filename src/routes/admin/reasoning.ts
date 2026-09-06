import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../../types';
import { authMiddleware, requireAdmin, type AuthVariables } from '../../middleware/auth';
import { createRateLimiter } from '../../middleware/rate-limit';
import { SETUP_KEYS } from '../../lib/kv-keys';
import { createLogger } from '../../lib/logger';
import { parseReasoningConfiguration } from '../../lib/reasoning-configuration';
import {
  BUILT_IN_REASONING_PROFILES,
  COMPATIBILITY_NOTICES,
  canonicalHash,
  canonicalJson,
  isPiReasoningLevel,
  normalizeCustomProfile,
  type NormalizedReasoningProfile,
} from '../../lib/reasoning-profiles';
import { discoverPiCompatibility, PI_WIRE_CANARY_VERSION } from '../../lib/reasoning-discovery';
import {
  backendDescriptionsSchema, connectionStatus, dynamicRouteSchema, gatewayDraftSchema,
  listDynamicRoutes, parseGatewayUrl, resolveGatewayConnection, type GatewayDraft,
} from '../../lib/ai-gateway-management';
import {
  assignmentBackendDescriptions, completedProfileCheck, connectionFingerprint, issueRouteCheck,
  loadCheckedRouteInventory, profileRevisionRefSchema, verificationMatches,
  type RouteVerification,
} from '../../lib/reasoning-verification';
import type { RouteReasoningAssignment } from '../../lib/reasoning-configuration';
import {
  DynamicRouteInventoryError,
  deriveCommonMapping,
  type DynamicRouteInventory,
  type LegMappingEvidence,
} from '../../lib/dynamic-route-inventory';

const logger = createLogger('admin-reasoning');
const routeSchema = dynamicRouteSchema;
const profileRefSchema = profileRevisionRefSchema;
const catalogSchema = z.object({ gateway: gatewayDraftSchema.optional() }).strict();
const inventorySchema = catalogSchema.extend({ backendDescriptions: backendDescriptionsSchema.optional() }).strict();
const discoverySchema = z.object({
  route: routeSchema,
  profileRef: profileRefSchema.optional(),
  profileDraft: z.unknown().optional(),
  backendDescriptions: backendDescriptionsSchema.optional(),
  gateway: gatewayDraftSchema.optional(),
  maxCompletionTokens: z.number().int().min(32).max(16_384).default(4096),
}).strict();

type ProfileRef = z.infer<typeof profileRefSchema>;

interface ReasoningConfigurationView {
  customProfileRevisions: Record<string, unknown>[];
  routeAssignments: Record<string, Record<string, unknown>>;
}

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
  return [...(BUILT_IN_REASONING_PROFILES as unknown as readonly Record<string, unknown>[]), ...configuration.customProfileRevisions];
}

function resolveProfile(configuration: ReasoningConfigurationView, requested: ProfileRef): Record<string, unknown> | null {
  return allProfiles(configuration).find((profile) => {
    const reference = profileRefFor(profile);
    return reference !== null && sameProfileRef(reference, requested) && profile.enabled !== false;
  }) ?? null;
}

function profileDiscoveryContract(profile: Record<string, unknown>): Record<string, unknown> {
  return {
    supportedLevels: profile.supportedLevels,
    removePaths: profile.removePaths,
    levels: profile.levels,
    aliases: profile.aliases,
    offSemantics: profile.offSemantics,
  };
}

function distinctDiscoveryCandidates(): Record<string, unknown>[] {
  const seen = new Set<string>();
  return (BUILT_IN_REASONING_PROFILES as unknown as readonly Record<string, unknown>[]).filter((profile) => {
    const digest = canonicalHash(profileDiscoveryContract(profile));
    if (seen.has(digest)) return false;
    seen.add(digest);
    return true;
  });
}

interface DiscoveryCandidateReport {
  profile: Record<string, unknown>;
  report: Record<string, any>;
}

function coversProfile(observed: Record<string, unknown>, requested: Record<string, unknown>): boolean {
  const observedLevels = Array.isArray(observed.supportedLevels) ? observed.supportedLevels.filter(isPiReasoningLevel) : [];
  const requestedLevels = Array.isArray(requested.supportedLevels) ? requested.supportedLevels.filter(isPiReasoningLevel) : [];
  if (requestedLevels.length === 0 || !requestedLevels.every((level) => observedLevels.includes(level))) return false;
  const observedMappings = observed.levels;
  const requestedMappings = requested.levels;
  if (!isPlainObject(observedMappings) || !isPlainObject(requestedMappings)) return false;
  return canonicalJson({
    removePaths: observed.removePaths,
    levels: Object.fromEntries(requestedLevels.map((level) => [level, observedMappings[level]])),
  }) === canonicalJson({
    removePaths: requested.removePaths,
    levels: Object.fromEntries(requestedLevels.map((level) => [level, requestedMappings[level]])),
  });
}

function dominatesCandidate(left: DiscoveryCandidateReport, right: DiscoveryCandidateReport): boolean {
  return Array.isArray(left.profile.supportedLevels) && Array.isArray(right.profile.supportedLevels)
    && left.profile.supportedLevels.length > right.profile.supportedLevels.length
    && coversProfile(left.profile, right.profile);
}

function distinctCandidateReports(reports: DiscoveryCandidateReport[]): DiscoveryCandidateReport[] {
  return reports.filter(({ profile }, index) => !reports.slice(0, index).some((previous) =>
    coversProfile(previous.profile, profile) && coversProfile(profile, previous.profile)));
}

function observedCandidate({ profile, report }: DiscoveryCandidateReport): DiscoveryCandidateReport | null {
  const supportedLevels = Array.isArray(report.compatibleLevels) ? report.compatibleLevels.filter(isPiReasoningLevel) : [];
  if (supportedLevels.length === 0 || !isPlainObject(profile.levels)) return null;
  const mappings = profile.levels;
  return {
    profile: {
      ...profile,
      supportedLevels,
      levels: Object.fromEntries(supportedLevels.map((level) => [level, mappings[level]])),
      aliases: isPlainObject(profile.aliases) ? Object.fromEntries(Object.entries(profile.aliases)
        .filter(([level, target]) => isPiReasoningLevel(level) && isPiReasoningLevel(target)
          && supportedLevels.includes(level) && supportedLevels.includes(target))) : {},
      offSemantics: supportedLevels.includes('off') ? profile.offSemantics : { status: 'unsupported' },
    },
    report: {
      ...report,
      assignable: true,
      classification: report.assignable ? report.classification : 'Compatible, unverified',
      piCompatibility: { status: 'verified', verifiedLevels: supportedLevels, failedLevels: [] },
      evidence: { ...report.evidence, toolReplay: true, status: 'Compatible, unverified' },
    },
  };
}

export function selectUnambiguousCandidateMatch(reports: DiscoveryCandidateReport[]): DiscoveryCandidateReport | null {
  const compatible = reports.filter(({ report }) => report.assignable === true);
  const maximal = compatible.filter((candidate) => !compatible.some((other) => other !== candidate && dominatesCandidate(other, candidate)));
  return maximal.length === 1 ? maximal[0] : null;
}

function generatedProfileDraft(profile: Record<string, unknown>, report: Record<string, any>, route: string): Record<string, unknown> {
  const observedAt = new Date().toISOString();
  const verifiedLevels = Array.isArray(report.piCompatibility?.verifiedLevels)
    ? report.piCompatibility.verifiedLevels.filter(isPiReasoningLevel)
    : [];
  const aliases = isPlainObject(profile.aliases)
    ? Object.fromEntries(Object.entries(profile.aliases).filter(([level, target]) => verifiedLevels.includes(level) && verifiedLevels.includes(target as any)))
    : {};
  const levels = isPlainObject(profile.levels)
    ? Object.fromEntries(Object.entries(profile.levels).filter(([level]) => verifiedLevels.includes(level as any)))
    : {};
  return {
    schemaVersion: 1,
    enabled: true,
    family: 'Discovered',
    description: `Deterministically discovered from dynamic route ${route}.`,
    ingressContract: 'ai-gateway-chat-completions',
    supportedLevels: verifiedLevels,
    removePaths: Array.isArray(profile.removePaths) ? profile.removePaths : [],
    levels,
    aliases,
    offSemantics: profile.offSemantics,
    toolCompatibility: { status: 'unverified', levels: [] },
    recognizedResponseFields: isPlainObject(profile.recognizedResponseFields) ? profile.recognizedResponseFields : {},
    validatedTransports: [],
    classification: 'Compatible, unverified',
    limitations: Array.isArray(report.limitations) ? report.limitations : [],
    originallyCreatedAgainst: { route, observedAt, evidenceType: 'deterministic-pi-discovery' },
    evidence: [{ ...report.evidence, route, observedAt, evidenceType: 'deterministic-pi-discovery' }],
  };
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
        if (!isPiReasoningLevel(level) || !Array.isArray(profile.levels[level])) continue;
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
    ...(Object.keys(common.levels).length > 0 && { commonMapping: { levels: common.levels, digest: canonicalHash(common.levels) } }),
    warnings: [...new Set(warnings)],
  };
}

const reasoningRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
reasoningRoutes.use('*', authMiddleware);

type ReasoningContext = Context<{ Bindings: Env; Variables: AuthVariables }>;

async function catalog(c: ReasoningContext, draft?: GatewayDraft) {
  let configuration: ReasoningConfigurationView;
  try { configuration = await readReasoningConfiguration(c.env.KV); } catch {
    return c.json({ error: 'Reasoning configuration unavailable', code: 'reasoning_configuration_unavailable' }, 503);
  }
  let routes: string[] = [];
  let routeCatalogStatus: 'ready' | 'unavailable' = 'unavailable';
  const gateway = await resolveGatewayConnection(c.env, draft);
  const parsedGateway = parseGatewayUrl(gateway.gatewayUrl);
  let connection = connectionStatus(undefined, true);
  if (parsedGateway && connectionFingerprint(gateway)) {
    try {
      routes = (await listDynamicRoutes(parsedGateway.accountId, parsedGateway.gatewayId, gateway.token!)).map((route) => route.name);
      routeCatalogStatus = 'ready';
      connection = connectionStatus();
    } catch (error) {
      connection = connectionStatus(error);
      logger.warn('Dynamic route catalog discovery failed');
    }
  }
  return c.json({
    schemaVersion: 1,
    profiles: allProfiles(configuration).map(sanitizeProfile),
    notices: COMPATIBILITY_NOTICES.map(sanitizeNotice),
    usage: assignmentUsage(configuration),
    routes,
    routeCatalogStatus,
    connection,
  });
}
reasoningRoutes.get('/catalog', requireAdmin, (c) => catalog(c));
reasoningRoutes.post('/catalog', requireAdmin, async (c) => {
  const request = catalogSchema.safeParse(await c.req.json().catch(() => null));
  if (!request.success) return c.json({ error: 'Invalid catalog request', code: 'validation_error' }, 400);
  return catalog(c, request.data.gateway);
});

async function routeInventory(c: ReasoningContext, draft: z.infer<typeof inventorySchema> = {}) {
  const routeResult = routeSchema.safeParse(c.req.param('route'));
  if (!routeResult.success) return c.json({ error: 'Dynamic route not found', code: 'not_found' }, 404);
  const gateway = await resolveGatewayConnection(c.env, draft.gateway);
  if (!connectionFingerprint(gateway)) {
    return c.json({ error: 'AI Gateway credentials unavailable', code: 'gateway_unavailable' }, 503);
  }
  try {
    const configuration = await readReasoningConfiguration(c.env.KV);
    const stored = configuration.routeAssignments[routeResult.data] as unknown as RouteReasoningAssignment | undefined;
    const descriptions = draft.backendDescriptions ?? assignmentBackendDescriptions(stored);
    const current = await loadCheckedRouteInventory(gateway, routeResult.data, descriptions);
    const assignment = stored && { ...stored, legs: stored.legs?.map((leg) => ({ ...leg, customProviderBackend: Object.hasOwn(descriptions, leg.nodeId) ? descriptions[leg.nodeId] : undefined })) };
    const body = buildInventoryResponse(routeResult.data, current.inventory, assignment as unknown as Record<string, unknown>, configuration);
    // Draft provenance may refer to an as-yet unassigned leg.
    for (const leg of body.legs as Array<Record<string, unknown>>) {
      if (Object.hasOwn(current.backendDescriptions, String(leg.nodeId))) {
        leg.customProviderBackend = current.backendDescriptions[String(leg.nodeId)];
        leg.provenance = 'administrator-declared';
      }
    }
    const profile = stored ? resolveProfile(configuration, stored.activeProfile) : null;
    const verification = profile && verificationMatches(stored?.verification, profile as unknown as NormalizedReasoningProfile, gateway, current)
      ? stored?.verification : undefined;
    return c.json({ ...body, inventoryDigest: current.inventoryDigest, ...(verification && { verification }) });
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
}
reasoningRoutes.get('/routes/:route/inventory', requireAdmin, (c) => routeInventory(c));
reasoningRoutes.post('/routes/:route/inventory', requireAdmin, async (c) => {
  const request = inventorySchema.safeParse(await c.req.json().catch(() => null));
  if (!request.success) return c.json({ error: 'Invalid inventory request', code: 'validation_error' }, 400);
  return routeInventory(c, request.data);
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
  let profile = request.data.profileRef ? resolveProfile(configuration, request.data.profileRef) : null;
  if (request.data.profileDraft !== undefined) {
    try {
      if (!request.data.profileRef) throw new Error('Exact profile reference required');
      const draft = normalizeCustomProfile(request.data.profileDraft);
      if (!draft.enabled || !sameProfileRef(draft, request.data.profileRef)) throw new Error('Canonical enabled draft required');
      const prior = allProfiles(configuration).find((candidate) => candidate.id === draft.id && candidate.revision === draft.revision);
      if (prior && (prior.enabled === false || prior.hash !== draft.hash)) throw new Error('Existing revision is immutable');
      profile = draft as unknown as Record<string, unknown>;
    } catch {
      return c.json({ error: 'Invalid or immutable profile draft', code: 'validation_error' }, 400);
    }
  }
  if (request.data.profileRef && !profile) return c.json({ error: 'Reasoning profile revision not found', code: 'not_found' }, 404);

  const gateway = await resolveGatewayConnection(c.env, request.data.gateway);
  const parsedGateway = parseGatewayUrl(gateway.gatewayUrl);
  if (!parsedGateway || !gateway.token || !connectionFingerprint(gateway)) {
    return c.json({ error: 'AI Gateway credentials unavailable', code: 'gateway_unavailable' }, 503);
  }

  try {
    if (profile && request.data.profileRef) {
      const stored = configuration.routeAssignments[request.data.route] as unknown as RouteReasoningAssignment | undefined;
      const descriptions = request.data.backendDescriptions ?? assignmentBackendDescriptions(stored);
      const before = await loadCheckedRouteInventory(gateway, request.data.route, descriptions);
      if (!before.provenanceComplete || before.inventory.models.length === 0) {
        return c.json({ error: 'Custom provider backend provenance is required before verification', code: 'validation_error' }, 400);
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
      if (completedProfileCheck(report, profile as unknown as NormalizedReasoningProfile)) {
        const after = await loadCheckedRouteInventory(gateway, request.data.route, descriptions);
        if (before.inventoryDigest !== after.inventoryDigest) return c.json({ ...report, warnings: ['route_inventory_changed'] });
        const verification: RouteVerification = {
          schemaVersion: 1, profileRef: request.data.profileRef, routeVersion: after.inventory.versionId,
          inventoryDigest: after.inventoryDigest, connectionFingerprint: connectionFingerprint(gateway)!,
          canaryVersion: PI_WIRE_CANARY_VERSION, supportedLevels: [...(profile as unknown as NormalizedReasoningProfile).supportedLevels],
          scope: after.scope, checkedAt: new Date().toISOString(),
        };
        const checkId = await issueRouteCheck(c.env.KV, request.data.route, verification);
        return c.json({ ...report, checkId, verification, ...(verification.scope === 'observed-path' && { warnings: ['observed_path_only'] }) });
      }
      return c.json(report);
    }

    const routes = await listDynamicRoutes(parsedGateway.accountId, parsedGateway.gatewayId, gateway.token);
    if (!routes.some((route) => route.name === request.data.route)) return c.json({ error: 'Dynamic route not found', code: 'not_found' }, 404);
    const reports: DiscoveryCandidateReport[] = [];
    for (const candidate of distinctDiscoveryCandidates()) {
      const report = await discoverPiCompatibility({
        accountId: parsedGateway.accountId,
        gatewayId: parsedGateway.gatewayId,
        apiToken: gateway.token,
        route: `dynamic/${request.data.route}`,
        profile: candidate,
        maxCompletionTokens: request.data.maxCompletionTokens,
      });
      reports.push({ profile: candidate, report });
      // A rejected candidate is not a retry. Authentication, quota, server, stream,
      // and transport failures stop the entire scan, including later candidates.
      if (report.stopDiscovery) break;
    }
    const stopped = reports.some(({ report }) => report.stopDiscovery === true);
    const observed = reports.map(observedCandidate).filter((candidate): candidate is DiscoveryCandidateReport => candidate !== null);
    // Reuse the finite protocol observations for catalog matching. Saved custom
    // revisions do not expand the paid probe campaign or inject new request paths.
    const matches = allProfiles(configuration).filter((profile) => profile.enabled !== false).flatMap((profile) => {
      const observation = observed.find((candidate) => coversProfile(candidate.profile, profile));
      return observation ? [{ profile, report: observation.report }] : [];
    });
    const accounting = reports.reduce((total, { report }) => ({
      logicalProbes: total.logicalProbes + Number(report.accounting?.logicalProbes ?? 0),
      httpAttempts: total.httpAttempts + Number(report.accounting?.httpAttempts ?? 0),
      promptTokens: total.promptTokens + Number(report.accounting?.promptTokens ?? 0),
      completionTokens: total.completionTokens + Number(report.accounting?.completionTokens ?? 0),
      totalTokens: total.totalTokens + Number(report.accounting?.totalTokens ?? 0),
    }), { logicalProbes: 0, httpAttempts: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    // Existing revisions are independent administrator choices, not competing
    // runtime mappings. Only a new draft requires one coherent observed fit.
    const existingMatches = stopped ? [] : matches;
    const candidates = distinctCandidateReports(observed);
    const selected = stopped || existingMatches.length > 0 ? null : selectUnambiguousCandidateMatch(candidates);
    const diagnostics = reports.flatMap(({ report }) => report.diagnostics ?? []);
    const ambiguous = !stopped && existingMatches.length === 0 && !selected && candidates.length > 1;
    const inconclusive = stopped || diagnostics.some((diagnostic) => diagnostic.code === 'completion_limit');
    const outcome = existingMatches.length > 0 ? 'existing-profile' : selected ? 'custom-profile'
      : ambiguous ? 'ambiguous' : inconclusive ? 'inconclusive' : 'unsupported';
    const matchedProfiles = existingMatches.map(({ profile: candidate }) => ({
      profileRef: profileRefFor(candidate)!, name: candidate.name, supportedLevels: candidate.supportedLevels,
    }));
    const assignable = existingMatches.length > 0 || selected !== null;
    const result = {
      schemaVersion: 1,
      route: request.data.route,
      outcome,
      requestedCompletionCeiling: request.data.maxCompletionTokens,
      classification: existingMatches.length > 0
        ? existingMatches.every(({ report }) => report.classification === 'Verified') ? 'Verified' : 'Compatible, unverified'
        : selected ? selected.report.classification : outcome === 'unsupported' ? 'Unsupported' : 'Inconclusive',
      assignable,
      matchedProfiles,
      diagnostics,
      accounting,
      candidateResults: reports.map(({ profile: candidate, report }) => ({
        profileId: candidate.id,
        profileName: candidate.name,
        classification: report.classification,
        assignable: report.assignable,
        verifiedLevels: report.compatibleLevels,
        diagnostics: report.diagnostics,
      })),
      ...(selected && { matchedCandidateProfileId: selected.profile.id }),
      ...(selected && outcome === 'custom-profile' && { profileDraft: generatedProfileDraft(selected.profile, selected.report, request.data.route) }),
      ...(!assignable && { warnings: [ambiguous ? 'ambiguous_profile_mapping' : 'no_compatible_profile_mapping'] }),
    };
    logger.info('Custom reasoning profile discovery completed', {
      initiatedBy: c.get('user')?.email ?? 'unknown',
      route: request.data.route,
      matchedCandidateProfileId: selected?.profile.id ?? null,
      candidateMatches: matches.length,
      logicalProbes: accounting.logicalProbes,
      httpAttempts: accounting.httpAttempts,
    });
    return c.json(result);
  } catch (error) {
    if (error instanceof Error && error.message === 'route_not_found') return c.json({ error: 'Dynamic route not found', code: 'not_found' }, 404);
    logger.warn('Reasoning discovery failed', {
      route: request.data.route,
      profileId: request.data.profileRef?.id ?? 'auto-discovery',
      initiatedBy: c.get('user')?.email ?? 'unknown',
    });
    return c.json({ error: 'Reasoning discovery unavailable', code: 'discovery_unavailable' }, 502);
  }
});

export default reasoningRoutes;
