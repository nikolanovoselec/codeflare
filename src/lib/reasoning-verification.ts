import { z } from 'zod';
import { canonicalHash, canonicalJson, type NormalizedReasoningProfile, type PiReasoningLevel } from './reasoning-profiles';
import { PI_WIRE_CANARY_VERSION } from './reasoning-discovery';
import { inventoryDynamicRoute, type DynamicRouteInventory, type DynamicRouteVersionInput } from './dynamic-route-inventory';
import { backendDescriptionsSchema, dynamicRouteSchema, loadActiveRouteVersion, parseGatewayUrl, type GatewayConnection } from './ai-gateway-management';

import { parseFallbackRouting, parseRouteVerification, type RouteVerification } from './reasoning-configuration';
export type { FallbackRouting, RouteVerification } from './reasoning-configuration';
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const profileRevisionRefSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  revision: z.number().int().positive(), hash: hashSchema,
}).strict();
// Worker request schemas delegate to the dependency-free document parsers used
// by the browser, keeping saved data validation under one owner.
function parsedSchema<T>(parse: (value: unknown) => T) {
  return z.unknown().transform((value, context): T | typeof z.NEVER => {
    try { return parse(value); } catch (error) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : 'Invalid configuration' });
      return z.NEVER;
    }
  });
}
export const routeVerificationSchema = parsedSchema(parseRouteVerification);
export const fallbackRoutingSchema = parsedSchema(parseFallbackRouting);
export const ROUTE_CHECK_TTL_SECONDS = 15 * 60;
const CHECK_PREFIX = 'admin:reasoning:check:';
const receiptSchema = z.object({ route: dynamicRouteSchema, verification: routeVerificationSchema }).strict();
export const routeCheckIdSchema = z.string().uuid();

export function connectionFingerprint(connection: GatewayConnection): string | null {
  const gateway = parseGatewayUrl(connection.gatewayUrl);
  if (!gateway || !connection.token || /[\u0000-\u001f\u007f]/.test(connection.token)) return null;
  return canonicalHash({ gateway, token: connection.token });
}
export function assignmentBackendDescriptions(assignment?: { legs?: Array<{ nodeId: string; customProviderBackend?: string }> }): Record<string, string> {
  return Object.fromEntries((assignment?.legs ?? []).flatMap((leg) => leg.customProviderBackend ? [[leg.nodeId, leg.customProviderBackend]] : []));
}
export interface CheckedRouteInventory {
  inventory: DynamicRouteInventory;
  inventoryDigest: string;
  scope: RouteVerification['scope'];
  backendDescriptions: Record<string, string>;
  provenanceComplete: boolean;
}
export function checkedRouteInventory(active: DynamicRouteVersionInput, descriptions: Record<string, string> = {}): CheckedRouteInventory {
  const validDescriptions = backendDescriptionsSchema.parse(descriptions);
  const inventory = inventoryDynamicRoute(active);
  const customModels = inventory.models.filter((model) => model.provider.toLowerCase().startsWith('custom'));
  const backendDescriptions = Object.fromEntries(customModels.flatMap((model) => Object.prototype.hasOwnProperty.call(validDescriptions, model.nodeId) ? [[model.nodeId, validDescriptions[model.nodeId]]] : []));
  // Include full topology and model properties, but never return management data or
  // include mutable evidence/warnings in the digest. Element ordering is immaterial.
  const topology = [...(active.elements as Array<Record<string, unknown>>)].sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((node) => ({ id: node.id, type: node.type, properties: node.properties ?? {}, outputs: node.outputs }));
  const observedPath = inventory.models.length !== 1 || inventory.paths.length !== 1
    || inventory.paths.some((path) => path.branches.length > 0)
    || topology.some((node) => !['start', 'model', 'end'].includes(String(node.type).toLowerCase()));
  return {
    inventory, backendDescriptions,
    inventoryDigest: canonicalHash({ routeVersion: active.versionId, topology, backendDescriptions }),
    scope: observedPath ? 'observed-path' : 'single-model',
    provenanceComplete: customModels.every((model) => Object.prototype.hasOwnProperty.call(backendDescriptions, model.nodeId)),
  };
}
export async function loadCheckedRouteInventory(connection: GatewayConnection, route: string, descriptions: Record<string, string> = {}): Promise<CheckedRouteInventory> {
  dynamicRouteSchema.parse(route);
  backendDescriptionsSchema.parse(descriptions);
  const gateway = parseGatewayUrl(connection.gatewayUrl);
  if (!gateway || !connectionFingerprint(connection)) throw new Error('AI Gateway credentials unavailable');
  const active = await loadActiveRouteVersion(gateway.accountId, gateway.gatewayId, route, connection.token!);
  return checkedRouteInventory(active, descriptions);
}
export function verificationMatches(
  verification: RouteVerification | undefined,
  profile: NormalizedReasoningProfile,
  connection: GatewayConnection,
  current?: CheckedRouteInventory,
): boolean {
  if (!verification || !profile.enabled || verification.canaryVersion !== PI_WIRE_CANARY_VERSION
    || canonicalJson(verification.profileRef) !== canonicalJson({ id: profile.id, revision: profile.revision, hash: profile.hash })
    || canonicalJson(verification.supportedLevels) !== canonicalJson(profile.supportedLevels)
    || verification.connectionFingerprint !== connectionFingerprint(connection)) return false;
  return !current || (current.provenanceComplete && current.inventory.models.length > 0
    && verification.routeVersion === current.inventory.versionId
    && verification.inventoryDigest === current.inventoryDigest && verification.scope === current.scope);
}
export function completedProfileCheck(report: Record<string, any>, profile: { supportedLevels: readonly PiReasoningLevel[] }): boolean {
  const levels = profile.supportedLevels;
  return report.canaryVersion === PI_WIRE_CANARY_VERSION && report.stopDiscovery === false
    && report.piCompatibility?.status === 'verified' && report.piCompatibility.failedLevels?.length === 0
    && report.reasoningConfiguration?.routeHealthVerified === true
    && (!levels.includes('off') || report.reasoningConfiguration?.off === 'verified-disabled')
    && levels.every((level) => report.compatibleLevels?.includes(level) && report.piCompatibility.verifiedLevels?.includes(level)
      && report.distinctMappings?.some((mapping: Record<string, any>) => mapping.levels?.includes(level)
        && mapping.reasoningProbe?.status === 200 && mapping.reasoningProbe.malformedEvents === 0
        && mapping.toolLifecycle?.passed === true && mapping.toolLifecycle.stage === 'complete'
        && mapping.toolLifecycle.first?.status === 200 && mapping.toolLifecycle.replay?.status === 200));
}
export async function issueRouteCheck(kv: KVNamespace, route: string, verification: RouteVerification): Promise<string> {
  const receipt = receiptSchema.parse({ route, verification });
  const checkId = crypto.randomUUID();
  // Immutable, one write per unique key. Never assume this put is immediately visible.
  await kv.put(`${CHECK_PREFIX}${checkId}`, JSON.stringify(receipt), { expirationTtl: ROUTE_CHECK_TTL_SECONDS });
  return checkId;
}
export async function readRouteCheck(kv: KVNamespace, checkId: string): Promise<z.infer<typeof receiptSchema>> {
  routeCheckIdSchema.parse(checkId);
  const retry = 'Route check receipt unavailable. Retry Save without rerunning the paid check; if it has expired, explicitly check the route again.';
  let raw: string | null;
  try { raw = await kv.get(`${CHECK_PREFIX}${checkId}`); } catch { throw new Error(retry); }
  if (!raw) throw new Error(retry);
  let receipt: z.infer<typeof receiptSchema>;
  try { receipt = receiptSchema.parse(JSON.parse(raw)); } catch { throw new Error(retry); }
  const age = Date.now() - Date.parse(receipt.verification.checkedAt);
  if (age < 0 || age >= ROUTE_CHECK_TTL_SECONDS * 1000) throw new Error(retry);
  return receipt;
}
export function preferredReasoningLevel(levels: readonly PiReasoningLevel[]): PiReasoningLevel | undefined {
  return levels.includes('medium') ? 'medium' : levels.includes('off') ? 'off' : levels[0];
}
