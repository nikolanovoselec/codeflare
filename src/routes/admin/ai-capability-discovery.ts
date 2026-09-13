import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../../types';
import { requireAdmin, type AuthVariables } from '../../middleware/auth';
import { createRateLimiter } from '../../middleware/rate-limit';
import { SETUP_KEYS } from '../../lib/kv-keys';
import { discoverTargetCapabilities } from '../../lib/ai-capability-discovery';
import { BEDROCK_MESSAGES_DEFAULT_PROFILE } from '../../lib/native-ai-target-draft';
import { getBuiltInProfileRef } from '../../lib/reasoning-profiles';
import { parseReasoningConfiguration } from '../../lib/reasoning-configuration';
import { backendDescriptionsSchema, dynamicRouteSchema, gatewayCoordinates, gatewayDraftSchema, listNativeProviderConfigs,
  resolveGatewayConnection, selectNativeProviderConfig } from '../../lib/ai-gateway-management';
import { assignmentBackendDescriptions, completedProfileCheck, connectionFingerprint, issueRouteCheck, loadCheckedRouteInventory,
  type RouteVerification } from '../../lib/reasoning-verification';
import { createNativeTarget, issueNativeTargetCheck, nativeTargetAdapterVersion, nativeTargetProfileDiscoveryDraftSchema,
  parseNativeAiTargets, type NativeTargetVerification } from '../../lib/native-ai-targets';

const requestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dynamic-route'), route: dynamicRouteSchema, backendDescriptions: backendDescriptionsSchema.optional(),
    gateway: gatewayDraftSchema.optional() }).strict(),
  z.object({ kind: z.literal('native-provider'), target: nativeTargetProfileDiscoveryDraftSchema,
    gateway: gatewayDraftSchema.optional() }).strict(),
]);
const routes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
routes.use('*', requireAdmin, createRateLimiter({ windowMs: 60_000, maxRequests: 5, keyPrefix: 'admin-target-capabilities', failClosed: true }));

/** Thin authority adapter: the discovery component never chooses a tenant,
 * secret, provider configuration or routing handle. This endpoint binds its
 * observed result to the existing receipt/Save workflow; Discover itself does
 * not enable a target, mutate a route, or rewrite any saved configuration. */
routes.post('/discover', async (c) => {
  const parsed = requestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ code: 'validation_error', error: 'Invalid target discovery request' }, 400);
  const request = parsed.data;
  if (request.kind === 'native-provider' && request.target.provider !== 'aws-bedrock') {
    return c.json({ code: 'unsupported_native_protocol', error: 'Automatic native discovery currently supports the tested Bedrock boundary. Other native protocols require an explicit adapter extension.' }, 422);
  }
  const gateway = await resolveGatewayConnection(c.env, request.gateway);
  const coordinates = gatewayCoordinates(gateway);
  const fingerprint = connectionFingerprint(gateway);
  if (!coordinates || !gateway.token || !fingerprint) return c.json({ code: 'gateway_unavailable', error: 'AI Gateway connection unavailable' }, 503);
  let stage = 'configuration';
  try {
    const configuration = parseReasoningConfiguration(await c.env.KV.get(SETUP_KEYS.REASONING_CONFIGURATION)
      ?? { schemaVersion: 1, customProfileRevisions: [], routeAssignments: {} });
    const common = { ...coordinates, apiToken: gateway.token, maxCompletionTokens: 2048 };
    if (request.kind === 'dynamic-route') {
      stage = 'route-inventory';
      const descriptions = request.backendDescriptions ?? assignmentBackendDescriptions(configuration.routeAssignments[request.route]);
      const before = await loadCheckedRouteInventory(gateway, request.route, descriptions);
      if (!before.inventory.models.length) return c.json({ code: 'empty_route', error: 'The selected route contains no model' }, 409);
      stage = 'protocol-probes';
      const result = await discoverTargetCapabilities({ ...common, route: `dynamic/${request.route}`,
        requireBackendIdentity: new Set(before.inventory.models.map((model) => `${model.provider}/${model.model}`)).size > 1 });
      if (!result.assignable || !result.profile || !result.report || !completedProfileCheck(result.report, result.profile)) return c.json({ ...result, assignable: false });
      const profile = result.profile;
      const saved = configuration.customProfileRevisions.find((item) => item.id === profile.id && item.revision === profile.revision);
      if (saved && (!saved.enabled || saved.hash !== profile.hash)) return c.json({ code: 'profile_changed', error: 'The matching contract revision is disabled or changed; no existing revision was overwritten' }, 409);
      const after = await loadCheckedRouteInventory(gateway, request.route, descriptions);
      if (before.inventoryDigest !== after.inventoryDigest) return c.json({ code: 'route_changed', error: 'Route changed during discovery; no verification was issued' }, 409);
      const verification: RouteVerification = { schemaVersion: 1, profileRef: { id: profile.id, revision: profile.revision, hash: profile.hash },
        routeVersion: after.inventory.versionId, inventoryDigest: after.inventoryDigest, connectionFingerprint: fingerprint,
        canaryVersion: result.report.canaryVersion, supportedLevels: profile.supportedLevels, scope: after.scope,
        checkedAt: new Date().toISOString(), capabilities: result.capabilities };
      stage = 'verification-receipt';
      const checkId = await issueRouteCheck(c.env.KV, request.route, verification);
      return c.json({ ...result, checkId, routeVerification: verification });
    }

    stage = 'provider-inventory';
    const provider = selectNativeProviderConfig(await listNativeProviderConfigs(coordinates.accountId, coordinates.gatewayId, gateway.token), request.target.provider);
    if (!provider) return c.json({ code: 'provider_unavailable', error: 'Configured Bedrock provider not found' }, 409);
    const current = parseNativeAiTargets(await c.env.KV.get(SETUP_KEYS.NATIVE_AI_TARGETS));
    const existing = current.targets.find((target) => target.id === request.target.id);
    if (existing && (existing.provider !== provider.provider || existing.providerConfigId !== provider.id || existing.providerConfigAlias !== provider.alias || existing.customProvider)) {
      return c.json({ code: 'provider_changed', error: 'Configured provider binding changed; discovery did not substitute credentials' }, 409);
    }
    const native = request.target.transport !== 'aig-legacy-compat';
    stage = 'protocol-probes';
    const result = await discoverTargetCapabilities({ ...common, route: `aws-bedrock/${request.target.model}`, compatOnly: true,
      ...(provider.alias && { byokAlias: provider.alias }),
      ...(native && { native: { model: request.target.model, region: request.target.region!, transport: request.target.transport as 'aig-bedrock-anthropic-auto' | 'aig-bedrock-anthropic-invoke' | 'aig-bedrock-anthropic-eventstream' } }) });
    if (!result.assignable || !result.profile || !result.report || !completedProfileCheck(result.report, result.profile)) return c.json({ ...result, assignable: false });
    const profile = result.profile;
    const saved = configuration.customProfileRevisions.find((item) => item.id === profile.id && item.revision === profile.revision);
    if (saved && (!saved.enabled || saved.hash !== profile.hash)) return c.json({ code: 'profile_changed', error: 'The matching contract revision is disabled or changed' }, 409);
    const after = selectNativeProviderConfig(await listNativeProviderConfigs(coordinates.accountId, coordinates.gatewayId, gateway.token), request.target.provider);
    if (!after || after.id !== provider.id || after.alias !== provider.alias) return c.json({ code: 'provider_changed', error: 'Provider binding changed during discovery' }, 409);
    const profileRef = native ? getBuiltInProfileRef(BEDROCK_MESSAGES_DEFAULT_PROFILE) : { id: profile.id, revision: profile.revision, hash: profile.hash };
    const target = createNativeTarget({ ...request.target, id: existing?.id, providerConfigId: provider.id, providerConfigAlias: provider.alias, profileRef });
    const verification: NativeTargetVerification = { schemaVersion: 1, targetId: target.id, provider: target.provider, model: target.model,
      providerConfigId: provider.id, ...(provider.alias && { providerConfigAlias: provider.alias }), connectionFingerprint: fingerprint,
      profileRef, transport: target.transport, ...(target.region && { region: target.region }),
      adapterVersion: nativeTargetAdapterVersion(target.provider, target.transport), checkedAt: new Date().toISOString(), discovery: result.capabilities };
    stage = 'verification-receipt';
    const checkId = await issueNativeTargetCheck(c.env.KV, target.id, verification);
    return c.json({ ...result, checkId, targetId: target.id, nativeVerification: { method: 'automated', checkedAt: verification.checkedAt, current: true, discovery: result.capabilities } });
  } catch {
    // Provider errors are projected by discovery; management failures never
    // expose response bodies, provider aliases, credential identifiers or URLs.
    return c.json({ code: 'discovery_unavailable', stage, error: 'Target discovery unavailable; no configuration was changed' }, 502);
  }
});

export default routes;
