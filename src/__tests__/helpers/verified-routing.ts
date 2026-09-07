import { getRouteReasoningProfile, parseReasoningConfiguration, type ReasoningConfiguration } from '../../lib/reasoning-configuration';
import { assignmentBackendDescriptions, checkedRouteInventory, connectionFingerprint, type RouteVerification } from '../../lib/reasoning-verification';
import { PI_WIRE_CANARY_VERSION } from '../../lib/reasoning-discovery';
import type { GatewayConnection } from '../../lib/ai-gateway-management';
import type { DynamicRouteVersionInput } from '../../lib/dynamic-route-inventory';

export const routingGatewayUrl = 'https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/gateway';
export const routingInventoryFixtures = new Map<string, DynamicRouteVersionInput>();

/** Explicitly seed server-owned fixture authority; submitted evidence is not a check. */
export function verifiedRoutingConfiguration(input: unknown, connection: GatewayConnection): ReasoningConfiguration {
  const configuration = parseReasoningConfiguration(input);
  const routeAssignments = Object.fromEntries(Object.entries(configuration.routeAssignments).map(([route, assignment]) => {
    const legs = assignment.legs?.length ? assignment.legs : [{ nodeId: 'primary', provider: 'openai', declaredModel: 'fixture-model' }];
    const active = {
      versionId: assignment.routeVersion ?? 'fixture-version',
      elements: [
        { id: 'start', type: 'start', outputs: { next: { elementId: legs[0].nodeId } } },
        ...legs.map((leg, index) => ({ id: leg.nodeId, type: 'model', properties: { provider: leg.provider, model: leg.declaredModel }, outputs: { [index + 1 < legs.length ? 'fallback' : 'success']: { elementId: legs[index + 1]?.nodeId ?? 'end' } } })),
      ],
    };
    routingInventoryFixtures.set(route, active);
    const inventory = checkedRouteInventory(active, assignmentBackendDescriptions(assignment));
    const profile = getRouteReasoningProfile(configuration, route);
    const verification: RouteVerification = {
      schemaVersion: 1, profileRef: assignment.activeProfile, routeVersion: active.versionId,
      inventoryDigest: inventory.inventoryDigest, connectionFingerprint: connectionFingerprint(connection)!,
      canaryVersion: PI_WIRE_CANARY_VERSION, supportedLevels: profile.supportedLevels,
      scope: inventory.scope, checkedAt: new Date().toISOString(),
    };
    return [route, { ...assignment, routeVersion: active.versionId, verification }];
  }));
  return { ...configuration, routeAssignments, fallbackRouting: configuration.fallbackRouting ?? { enabled: false } };
}
