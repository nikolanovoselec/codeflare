import { z } from 'zod';
import type { Env } from '../types';
import {
  connectionStatus, dynamicRouteSchema, gatewayCoordinates, listCustomProviderSlugs, listDynamicRoutes,
  listNativeProviderConfigs, resolveGatewayConnection, type ConnectionStatus, type GatewayConnection, type NativeProviderConfig,
} from './ai-gateway-management';
import type { AiRoutingSettingWrite } from './admin-configuration';
import { SETUP_KEYS } from './kv-keys';
import { nativeTargetHandle, parseNativeAiTargets } from './native-ai-targets';
import { getProfileForRef, getRouteReasoningProfile, parseReasoningConfiguration, type ReasoningConfiguration } from './reasoning-configuration';
import { canonicalJson, type PiReasoningLevel } from './reasoning-profiles';
import { connectionFingerprint } from './reasoning-verification';

interface LiveRoutingInventory {
  routes?: string[];
  configs?: NativeProviderConfig[];
  customProviders: Set<string> | null;
  connection: ConnectionStatus;
}

/** Undefined means unavailable, never a successful empty inventory. Bindings remain Worker-only. */
export async function loadLiveRoutingInventory(gateway: GatewayConnection): Promise<LiveRoutingInventory> {
  const result: LiveRoutingInventory = { customProviders: null, connection: connectionStatus(undefined, true) };
  const coordinates = gatewayCoordinates(gateway);
  if (!coordinates || !connectionFingerprint(gateway)) return result;
  const { accountId, gatewayId } = coordinates;
  await Promise.all([
    (async () => {
      try {
        result.routes = (await listDynamicRoutes(accountId, gatewayId, gateway.token!)).map((route) => route.name);
        result.connection = connectionStatus();
      } catch (error) { result.connection = connectionStatus(error); }
    })(),
    (async () => {
      try { result.configs = await listNativeProviderConfigs(accountId, gatewayId, gateway.token!); }
      catch { return; }
      try { result.customProviders = await listCustomProviderSlugs(accountId, gateway.token!); }
      catch { /* Classification failure is not evidence of binding absence. */ }
    })(),
  ]);
  return result;
}

const levelSchema = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const targetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dynamic-route'), route: dynamicRouteSchema }).strict(),
  z.object({ kind: z.literal('native-target'), targetId: z.string().uuid() }).strict(),
]);
const policySchema = z.object({
  routes: z.array(dynamicRouteSchema).max(256),
  defaultRoute: z.union([dynamicRouteSchema, z.literal('')]),
  reasoning: levelSchema,
  targets: z.array(targetSchema).max(256).optional(),
  defaultTarget: targetSchema.optional(),
}).strict();
type Policy = z.infer<typeof policySchema>;
type Target = z.infer<typeof targetSchema>;
const windowSchema = z.record(dynamicRouteSchema, z.union([
  z.number().int().positive(),
  z.object({ contextWindow: z.number().int().positive(), reasoningProfile: z.string().max(64).optional() }).strict(),
]));
const settingKeys = [SETUP_KEYS.DYNAMIC_ROUTES, SETUP_KEYS.DEFAULT_ROUTE, SETUP_KEYS.ROUTE_CONTEXT_WINDOWS,
  SETUP_KEYS.NATIVE_AI_TARGETS, SETUP_KEYS.REASONING_CONFIGURATION, SETUP_KEYS.GROUP_ROUTING] as const;

/** REQ-ENTERPRISE-034/044/047/055: derive only deletions from complete saved-connection inventories. */
export async function prepareSavedRoutingReconciliation(env: Env) {
  const gateway = await resolveGatewayConnection(env);
  const fingerprint = connectionFingerprint(gateway);
  const raw = new Map(await Promise.all(settingKeys.map(async (key) => [key, await env.KV.get(key)] as const)));
  const read = (key: typeof settingKeys[number], fallback: unknown): unknown => {
    const value = raw.get(key);
    return value === null || value === undefined ? fallback : JSON.parse(value);
  };
  const dynamicRoutes = z.array(dynamicRouteSchema).max(256).parse(read(SETUP_KEYS.DYNAMIC_ROUTES, []));
  const defaults = z.object({ route: z.union([dynamicRouteSchema, z.literal('')]), reasoning: levelSchema }).strict()
    .parse(read(SETUP_KEYS.DEFAULT_ROUTE, { route: '', reasoning: 'off' }));
  const windows = windowSchema.parse(read(SETUP_KEYS.ROUTE_CONTEXT_WINDOWS, {}));
  const rawNative = read(SETUP_KEYS.NATIVE_AI_TARGETS, { schemaVersion: 1, targets: [] });
  const nativeTargets = parseNativeAiTargets(rawNative);
  const rawReasoning = read(SETUP_KEYS.REASONING_CONFIGURATION, { schemaVersion: 1, customProfileRevisions: [], routeAssignments: {} });
  // Validate without rewriting surviving profiles, receipts, or evidence as a side effect.
  const parsedConfiguration = parseReasoningConfiguration(rawReasoning);
  const configuration = rawReasoning as ReasoningConfiguration;
  const groups = z.record(z.string().min(1).max(256), policySchema).parse(read(SETUP_KEYS.GROUP_ROUTING, {}));
  const inventory = await loadLiveRoutingInventory(gateway);
  const nativeByHandle = new Map(nativeTargets.targets.map((target) => [nativeTargetHandle(target.id), target]));
  const handle = (target: Target): string => target.kind === 'dynamic-route' ? target.route : nativeTargetHandle(target.targetId);
  const candidates = new Set([...dynamicRoutes, ...Object.keys(windows), ...Object.keys(configuration.routeAssignments), defaults.route]);
  const collect = (policy: Policy) => {
    for (const route of [...policy.routes, policy.defaultRoute]) candidates.add(route);
    for (const target of [...(policy.targets ?? []), ...(policy.defaultTarget ? [policy.defaultTarget] : [])]) {
      if (target.kind === 'dynamic-route') candidates.add(target.route);
    }
  };
  Object.values(groups).forEach(collect);
  if (configuration.fallbackRouting?.enabled) collect(configuration.fallbackRouting);
  const liveRoutes = inventory.routes && new Set(inventory.routes);
  const removedDynamicRoutes = liveRoutes ? [...candidates].filter((route) => route && !nativeByHandle.has(route) && !liveRoutes.has(route)).sort() : [];
  const removedNativeTargetIds = nativeTargets.targets.filter((target) => inventory.configs !== undefined
    && !inventory.configs.some((provider) => provider.provider === target.provider && provider.id === target.providerConfigId)).map((target) => target.id);
  const removedDynamic = new Set(removedDynamicRoutes);
  const removedNative = new Set(removedNativeTargetIds);
  const removed = (route: string) => removedDynamic.has(route) || removedNative.has(nativeByHandle.get(route)?.id ?? '');
  const removedTarget = (target: Target) => target.kind === 'native-target' ? removedNative.has(target.targetId) : removedDynamic.has(target.route);
  const preference = (route: string): PiReasoningLevel | undefined => {
    try {
      const native = nativeByHandle.get(route);
      const profile = native ? getProfileForRef(parsedConfiguration, native.profileRef) : getRouteReasoningProfile(parsedConfiguration, route);
      if (profile.reasoningMode === 'provider-default') return 'off';
      return profile.supportedLevels.includes('medium') ? 'medium'
        : profile.supportedLevels.includes('off') ? 'off' : profile.supportedLevels[0];
    } catch { return undefined; }
  };
  const emptyPolicy = (): Policy => ({ routes: [], defaultRoute: '', reasoning: 'off', targets: [] });
  const prunePolicy = (policy: Policy): Policy => {
    if (!policy.routes.some(removed) && !removed(policy.defaultRoute)
      && !policy.targets?.some(removedTarget) && !(policy.defaultTarget && removedTarget(policy.defaultTarget))) return policy;
    const routes = policy.routes.filter((route) => !removed(route));
    const targets = policy.targets?.filter((target) => !removedTarget(target));
    const effective = targets ? targets.map(handle) : routes;
    if (effective.length === 0) return emptyPolicy();
    const priorDefault = policy.defaultTarget ? handle(policy.defaultTarget) : policy.defaultRoute;
    if (effective.includes(priorDefault) && !removed(policy.defaultRoute)) {
      return { ...policy, routes, ...(targets && { targets }) };
    }
    const defaultRoute = effective[0];
    const reasoning = preference(defaultRoute);
    // No new grants or borrowed levels when the first survivor has no usable profile.
    if (reasoning === undefined) return emptyPolicy();
    const { defaultTarget: _previous, ...rest } = policy;
    return { ...rest, routes, defaultRoute, reasoning, ...(targets && { targets, defaultTarget: targets[0] }) };
  };
  const fallback = configuration.fallbackRouting;
  const prunedFallback = fallback?.enabled ? prunePolicy({ routes: fallback.routes, defaultRoute: fallback.defaultRoute,
    reasoning: fallback.reasoning, ...(fallback.targets && { targets: fallback.targets }), ...(fallback.defaultTarget && { defaultTarget: fallback.defaultTarget }) }) : undefined;
  const nextReasoning: ReasoningConfiguration = {
    ...configuration,
    routeAssignments: Object.fromEntries(Object.entries(configuration.routeAssignments).filter(([route]) => !removedDynamic.has(route))),
    ...(prunedFallback && { fallbackRouting: (prunedFallback.targets ?? prunedFallback.routes).length
      ? { enabled: true as const, ...prunedFallback } : { enabled: false as const } }),
  };
  const savedNative = rawNative as typeof nativeTargets;
  const nextNative = { ...savedNative, targets: savedNative.targets.filter((target) => !removedNative.has(target.id)) };
  parseReasoningConfiguration(nextReasoning);
  parseNativeAiTargets(nextNative);
  const proposed: Array<readonly [typeof settingKeys[number], unknown]> = [
    [SETUP_KEYS.DYNAMIC_ROUTES, dynamicRoutes.filter((route) => !removedDynamic.has(route))],
    [SETUP_KEYS.DEFAULT_ROUTE, removed(defaults.route) ? { route: '', reasoning: 'off' } : defaults],
    [SETUP_KEYS.ROUTE_CONTEXT_WINDOWS, Object.fromEntries(Object.entries(windows).filter(([route]) => !removedDynamic.has(route)))],
    [SETUP_KEYS.NATIVE_AI_TARGETS, nextNative],
    [SETUP_KEYS.REASONING_CONFIGURATION, nextReasoning],
    [SETUP_KEYS.GROUP_ROUTING, Object.fromEntries(Object.entries(groups).map(([name, policy]) => [name, prunePolicy(policy)]))],
  ];
  const writes: AiRoutingSettingWrite[] = proposed.flatMap(([key, value]) => {
    const before = raw.get(key);
    return before !== null && before !== undefined && canonicalJson(JSON.parse(before)) !== canonicalJson(value)
      ? [[key, JSON.stringify(value)] as const] : [];
  });
  return { inventory, fingerprint, writes, removedDynamicRoutes, removedNativeTargetIds };
}
