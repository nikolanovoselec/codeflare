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
  getBuiltInProfileRef,
  isPiReasoningLevel,
  normalizeCustomProfile,
  type NormalizedReasoningProfile,
} from '../../lib/reasoning-profiles';
import { discoverPiCompatibility, PI_WIRE_CANARY_VERSION } from '../../lib/reasoning-discovery';
import {
  backendDescriptionsSchema, connectionStatus, dynamicRouteSchema, gatewayDraftSchema,
  gatewayCoordinates, listCustomProviderSlugs, listDynamicRoutes, listNativeProviderConfigs, resolveGatewayConnection,
  selectNativeProviderConfig, type GatewayDraft,
} from '../../lib/ai-gateway-management';
import {
  assignmentBackendDescriptions, completedProfileCheck, connectionFingerprint, issueRouteCheck,
  loadCheckedRouteInventory, profileRevisionRefSchema, verificationMatches,
  type RouteVerification,
} from '../../lib/reasoning-verification';
import type { RouteReasoningAssignment } from '../../lib/reasoning-configuration';
import {
  createNativeTarget, defaultNativeProfileId, issueNativeTargetCheck, nativeProviderSelector, nativeTargetAdapterVersion,
  nativeTargetDraftSchema, parseNativeAiTargets,
} from '../../lib/native-ai-targets';
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
const nativeDiscoverySchema = z.object({
  target: nativeTargetDraftSchema, profileDraft: z.unknown().optional(), administratorConfirmed: z.literal(true).optional(),
  gateway: gatewayDraftSchema.optional(), maxCompletionTokens: z.number().int().min(32).max(16_384).default(4096),
}).strict();
const nativeProfileDiscoverySchema = z.object({
  target: nativeTargetDraftSchema.omit({ profileRef: true }).extend({ profileRef: profileRefSchema.optional() }), gateway: gatewayDraftSchema.optional(),
  maxCompletionTokens: z.number().int().min(32).max(16_384).default(4096),
}).strict();
const discoverySchema = z.object({
  route: routeSchema,
  profileRef: profileRefSchema.optional(),
  profileDraft: z.unknown().optional(),
  administratorConfirmed: z.literal(true).optional(),
  backendDescriptions: backendDescriptionsSchema.optional(),
  gateway: gatewayDraftSchema.optional(),
  maxCompletionTokens: z.number().int().min(32).max(16_384).default(4096),
}).strict().refine((request) => !request.administratorConfirmed || Boolean(request.profileRef), 'Confirmation requires a selected profile');

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
  for (const key of ['id', 'name', 'description', 'family', 'schemaVersion', 'revision', 'hash', 'enabled', 'ingressContract', 'reasoningMode', 'supportedLevels', 'unsupportedLevels', 'removePaths', 'levels', 'aliases', 'offSemantics', 'toolCompatibility', 'recognizedResponseFields', 'validatedTransports', 'classification', 'limitations']) {
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

function generatedProfileDraft(profile: Record<string, unknown>, report: Record<string, any>, route: string, source = 'dynamic route'): Record<string, unknown> {
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
    description: `Deterministically discovered from ${source} ${route}.`,
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

function providerLabel(provider: string): string {
  const known: Record<string, string> = { 'aws-bedrock': 'Amazon Bedrock', 'google-ai-studio': 'Google AI Studio', openai: 'OpenAI' };
  return known[provider] ?? provider.split('-').map((word) => word ? word[0].toUpperCase() + word.slice(1) : '').join(' ');
}

async function catalog(c: ReasoningContext, draft?: GatewayDraft) {
  let configuration: ReasoningConfigurationView;
  try { configuration = await readReasoningConfiguration(c.env.KV); } catch {
    return c.json({ error: 'Reasoning configuration unavailable', code: 'reasoning_configuration_unavailable' }, 503);
  }
  let routes: string[] = [];
  let routeCatalogStatus: 'ready' | 'unavailable' = 'unavailable';
  let providers: Array<Record<string, unknown>> = [];
  let providerCatalogStatus: 'ready' | 'unavailable' = 'unavailable';
  const gateway = await resolveGatewayConnection(c.env, draft);
  const coordinates = gatewayCoordinates(gateway);
  let connection = connectionStatus(undefined, true);
  if (coordinates && connectionFingerprint(gateway)) {
    try {
      routes = (await listDynamicRoutes(coordinates.accountId, coordinates.gatewayId, gateway.token!)).map((route) => route.name);
      routeCatalogStatus = 'ready';
      connection = connectionStatus();
    } catch (error) {
      connection = connectionStatus(error);
      logger.warn('Dynamic route catalog discovery failed');
    }
    try {
      const configs = await listNativeProviderConfigs(coordinates.accountId, coordinates.gatewayId, gateway.token!);
      let customProviders: Set<string> | null = null;
      try { customProviders = await listCustomProviderSlugs(coordinates.accountId, gateway.token!); }
      catch { logger.warn('Custom provider catalog discovery failed'); }
      providers = [...new Set(configs.map((item) => item.provider))].sort().map((provider) => {
        let selected = null;
        try { selected = selectNativeProviderConfig(configs, provider); } catch { /* Ambiguous bindings remain visible but unavailable. */ }
        const builtInProvider = ['aws-bedrock', 'google-ai-studio', 'openai'].includes(provider);
        return {
          provider, label: providerLabel(provider), configured: true, defaultSelection: selected?.defaultSelection ?? false,
          supported: selected !== null && (builtInProvider || customProviders !== null), custom: customProviders?.has(provider) ?? false,
        };
      });
      providerCatalogStatus = 'ready';
    } catch { logger.warn('Native provider catalog discovery failed'); }
  }
  return c.json({
    schemaVersion: 1,
    profiles: allProfiles(configuration).map(sanitizeProfile),
    notices: COMPATIBILITY_NOTICES.map(sanitizeNotice),
    usage: assignmentUsage(configuration),
    routes,
    routeCatalogStatus,
    providers,
    providerCatalogStatus,
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

async function discoverNativeProfile(input: {
  accountId: string; gatewayId: string; token: string; selector: string; provider: string; alias?: string;
  configuration: ReasoningConfigurationView; maxCompletionTokens: number;
}): Promise<Record<string, unknown>> {
  const reports: DiscoveryCandidateReport[] = [];
  for (const candidate of distinctDiscoveryCandidates().filter((profile) => Array.isArray(profile.supportedLevels) && profile.supportedLevels.length > 0)) {
    const report = await discoverPiCompatibility({
      accountId: input.accountId, gatewayId: input.gatewayId, apiToken: input.token, route: input.selector,
      profile: candidate, maxCompletionTokens: input.maxCompletionTokens, compatOnly: true, ...(input.alias && { byokAlias: input.alias }),
    });
    reports.push({ profile: candidate, report });
    if (report.stopDiscovery) break;
  }
  const stopped = reports.some(({ report }) => report.stopDiscovery === true);
  const observed = reports.map(observedCandidate).filter((candidate): candidate is DiscoveryCandidateReport => candidate !== null);
  const matches = stopped ? [] : allProfiles(input.configuration).filter((profile) => profile.enabled !== false).flatMap((profile) => {
    const observation = observed.find((candidate) => coversProfile(candidate.profile, profile));
    return observation ? [{ profile, report: observation.report }] : [];
  });
  const selected = stopped || matches.length > 0 ? null : selectUnambiguousCandidateMatch(distinctCandidateReports(observed));
  const accounting = reports.reduce((total, item) => ({
    logicalProbes: total.logicalProbes + Number(item.report.accounting?.logicalProbes ?? 0),
    httpAttempts: total.httpAttempts + Number(item.report.accounting?.httpAttempts ?? 0),
  }), { logicalProbes: 0, httpAttempts: 0 });
  if (matches.length > 0) return {
    schemaVersion: 1, route: input.selector, outcome: 'existing-profile', classification: 'Verified', assignable: true,
    matchedProfiles: matches.map(({ profile }) => ({ profileRef: profileRefFor(profile), name: profile.name, supportedLevels: profile.supportedLevels })),
    diagnostics: reports.flatMap(({ report }) => report.diagnostics ?? []), accounting,
  };
  if (selected) return {
    schemaVersion: 1, route: input.selector, outcome: 'custom-profile', classification: selected.report.classification,
    assignable: true, matchedProfiles: [], diagnostics: selected.report.diagnostics ?? [], accounting,
    profileDraft: generatedProfileDraft(selected.profile, selected.report, input.selector, 'native provider target'),
  };
  if (!stopped) {
    const preparedId = defaultNativeProfileId(input.provider);
    const prepared = BUILT_IN_REASONING_PROFILES.find((profile) => profile.id === preparedId)!;
    const report = await discoverPiCompatibility({
      accountId: input.accountId, gatewayId: input.gatewayId, apiToken: input.token, route: input.selector,
      profile: prepared, maxCompletionTokens: input.maxCompletionTokens, compatOnly: true, ...(input.alias && { byokAlias: input.alias }),
    });
    if (completedProfileCheck(report, prepared)) {
      const known = ['aws-bedrock', 'google-ai-studio', 'openai', 'codeflare-inference-mesh'].includes(input.provider);
      return {
        schemaVersion: 1, route: input.selector, outcome: known ? 'existing-profile' : 'custom-profile', classification: 'Verified', assignable: true,
        matchedProfiles: known ? [{ profileRef: getBuiltInProfileRef(preparedId), name: prepared.name, supportedLevels: prepared.supportedLevels }] : [],
        diagnostics: report.diagnostics ?? [], accounting: report.accounting,
        ...(!known && { profileDraft: {
          ...generatedProfileDraft(prepared as unknown as Record<string, unknown>, report, input.selector, 'native provider target'),
          reasoningMode: 'provider-default', supportedLevels: [], levels: {}, aliases: {}, unsupportedLevels: [...(prepared.unsupportedLevels ?? [])],
        } }),
      };
    }
    return { ...report, route: input.selector, outcome: 'unsupported', assignable: false };
  }
  return {
    schemaVersion: 1, route: input.selector, outcome: 'inconclusive', classification: 'Inconclusive', assignable: false,
    diagnostics: reports.flatMap(({ report }) => report.diagnostics ?? []), accounting,
  };
}

reasoningRoutes.post('/native/profile-discovery', requireAdmin, discoveryRateLimiter, async (c) => {
  const request = nativeProfileDiscoverySchema.safeParse(await c.req.json().catch(() => null));
  if (!request.success) return c.json({ error: 'Invalid native profile discovery request', code: 'validation_error' }, 400);
  const gateway = await resolveGatewayConnection(c.env, request.data.gateway);
  const coordinates = gatewayCoordinates(gateway);
  if (!coordinates || !gateway.token || !connectionFingerprint(gateway)) return c.json({ error: 'AI Gateway credentials unavailable', code: 'gateway_unavailable' }, 503);
  try {
    const [configs, customProviders, configuration] = await Promise.all([
      listNativeProviderConfigs(coordinates.accountId, coordinates.gatewayId, gateway.token),
      listCustomProviderSlugs(coordinates.accountId, gateway.token),
      readReasoningConfiguration(c.env.KV),
    ]);
    const provider = selectNativeProviderConfig(configs, request.data.target.provider);
    if (!provider) return c.json({ error: 'Native provider configuration not found', code: 'provider_unavailable' }, 409);
    const selector = `${nativeProviderSelector(provider.provider, customProviders.has(provider.provider))}/${request.data.target.model}`;
    return c.json(await discoverNativeProfile({
      accountId: coordinates.accountId, gatewayId: coordinates.gatewayId, token: gateway.token, selector, provider: provider.provider,
      alias: provider.alias, configuration, maxCompletionTokens: request.data.maxCompletionTokens,
    }));
  } catch {
    return c.json({ error: 'Native profile discovery unavailable', code: 'discovery_unavailable' }, 502);
  }
});

reasoningRoutes.post('/native/discover', requireAdmin, discoveryRateLimiter, async (c) => {
  const request = nativeDiscoverySchema.safeParse(await c.req.json().catch(() => null));
  if (!request.success) return c.json({ error: 'Invalid native target check', code: 'validation_error' }, 400);
  const gateway = await resolveGatewayConnection(c.env, request.data.gateway);
  const coordinates = gatewayCoordinates(gateway);
  const fingerprint = connectionFingerprint(gateway);
  if (!coordinates || !gateway.token || !fingerprint) return c.json({ error: 'AI Gateway credentials unavailable', code: 'gateway_unavailable' }, 503);
  try {
    const [configs, customProviders] = await Promise.all([
      listNativeProviderConfigs(coordinates.accountId, coordinates.gatewayId, gateway.token),
      listCustomProviderSlugs(coordinates.accountId, gateway.token),
    ]);
    const provider = selectNativeProviderConfig(configs, request.data.target.provider);
    if (!provider) return c.json({ error: 'Native provider configuration not found', code: 'provider_unavailable' }, 409);
    const customProvider = customProviders.has(provider.provider);
    const providerConfigAlias = provider.alias;
    const configuration = await readReasoningConfiguration(c.env.KV);
    let profile = resolveProfile(configuration, request.data.target.profileRef);
    if (request.data.profileDraft !== undefined) {
      const draft = normalizeCustomProfile(request.data.profileDraft);
      if (!draft.enabled || !sameProfileRef(draft, request.data.target.profileRef)) throw new Error('Invalid native profile draft');
      const prior = allProfiles(configuration).find((candidate) => candidate.id === draft.id && candidate.revision === draft.revision);
      if (prior && (prior.enabled === false || prior.hash !== draft.hash)) throw new Error('Existing revision is immutable');
      profile = draft as unknown as Record<string, unknown>;
    }
    if (!profile) return c.json({ error: 'Native profile revision not found', code: 'not_found' }, 404);
    const current = parseNativeAiTargets(await c.env.KV.get(SETUP_KEYS.NATIVE_AI_TARGETS));
    const existing = request.data.target.id ? current.targets.find((candidate) => candidate.id === request.data.target.id) : undefined;
    if (existing && existing.provider === provider.provider && (existing.providerConfigId !== provider.id
      || existing.providerConfigAlias !== providerConfigAlias || Boolean(existing.customProvider) !== customProvider)) {
      return c.json({ error: 'Native provider configuration changed', code: 'provider_changed' }, 409);
    }
    const target = createNativeTarget({
      ...request.data.target, id: existing?.id, customProvider, providerConfigId: provider.id, providerConfigAlias,
      profileRef: request.data.target.profileRef,
    });
    const verification: import('../../lib/native-ai-targets').NativeTargetVerification = {
      schemaVersion: 1, ...(request.data.administratorConfirmed && { method: 'administrator' as const }), targetId: target.id,
      provider: target.provider, ...(target.customProvider && { customProvider: true }), model: target.model,
      providerConfigId: provider.id, ...(providerConfigAlias && { providerConfigAlias }), connectionFingerprint: fingerprint, profileRef: target.profileRef,
      transport: target.transport, adapterVersion: nativeTargetAdapterVersion(target.provider), checkedAt: new Date().toISOString(),
    };
    let report: Record<string, any> | undefined;
    if (!request.data.administratorConfirmed) {
      report = await discoverPiCompatibility({ accountId: coordinates.accountId, gatewayId: coordinates.gatewayId, apiToken: gateway.token,
        route: `${nativeProviderSelector(target.provider, Boolean(target.customProvider))}/${target.model}`, profile,
        maxCompletionTokens: request.data.maxCompletionTokens, compatOnly: true, ...(providerConfigAlias && { byokAlias: providerConfigAlias }) });
      if (!completedProfileCheck(report, profile)) return c.json({ ...report, assignable: false });
      verification.capabilities = { streaming: true, tools: true, replay: true };
    }
    const checkId = await issueNativeTargetCheck(c.env.KV, target.id, verification);
    return c.json({ targetId: target.id, classification: request.data.administratorConfirmed ? 'Administrator-confirmed' : 'Verified', assignable: true,
      checkId, verification: { method: verification.method ?? 'automated', checkedAt: verification.checkedAt, current: true }, ...(report && { report }) });
  } catch {
    return c.json({ error: 'Native target check unavailable', code: 'discovery_unavailable' }, 502);
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
  const coordinates = gatewayCoordinates(gateway);
  if (!coordinates || !gateway.token || !connectionFingerprint(gateway)) {
    return c.json({ error: 'AI Gateway credentials unavailable', code: 'gateway_unavailable' }, 503);
  }

  try {
    if (profile && request.data.profileRef) {
      const stored = configuration.routeAssignments[request.data.route] as unknown as RouteReasoningAssignment | undefined;
      const descriptions = request.data.backendDescriptions ?? assignmentBackendDescriptions(stored);
      const before = await loadCheckedRouteInventory(gateway, request.data.route, descriptions);
      if (before.inventory.models.length === 0) {
        return c.json({ error: 'The route must contain a model', code: 'validation_error' }, 400);
      }
      // REQ-ENTERPRISE-043: explicit admin authority uses the existing receipt/Save path, never fabricated canary results.
      if (request.data.administratorConfirmed) {
        const verification: RouteVerification = {
          schemaVersion: 1, method: 'administrator', profileRef: request.data.profileRef,
          routeVersion: before.inventory.versionId, inventoryDigest: before.inventoryDigest,
          connectionFingerprint: connectionFingerprint(gateway)!, canaryVersion: PI_WIRE_CANARY_VERSION,
          supportedLevels: [...(profile as unknown as NormalizedReasoningProfile).supportedLevels],
          scope: before.scope, checkedAt: new Date().toISOString(),
        };
        const checkId = await issueRouteCheck(c.env.KV, request.data.route, verification);
        return c.json({ route: request.data.route, classification: 'Administrator-confirmed', assignable: true, checkId, verification });
      }
      const report = await discoverPiCompatibility({
        accountId: coordinates.accountId,
        gatewayId: coordinates.gatewayId,
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

    const routes = await listDynamicRoutes(coordinates.accountId, coordinates.gatewayId, gateway.token);
    if (!routes.some((route) => route.name === request.data.route)) return c.json({ error: 'Dynamic route not found', code: 'not_found' }, 404);
    const reports: DiscoveryCandidateReport[] = [];
    for (const candidate of distinctDiscoveryCandidates()) {
      const report = await discoverPiCompatibility({
        accountId: coordinates.accountId,
        gatewayId: coordinates.gatewayId,
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
    const rateLimited = reports.some(({ report }) => report.stopDiscovery
      && report.diagnostics?.some((diagnostic: { status?: number }) => diagnostic.status === 429));
    // Stop paid requests on throttling, but retain independently completed mappings.
    const existingMatches = stopped
      ? rateLimited ? matches.filter(({ report }) => !report.stopDiscovery) : []
      : matches;
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
