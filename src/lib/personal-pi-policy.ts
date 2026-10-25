import { SETUP_KEYS } from './kv-keys';
import { parseReasoningConfiguration } from './reasoning-configuration';
import { isPiReasoningLevel } from './reasoning-profiles';

export type PiDefaultSource = 'managed' | 'pi-native';
export interface PersonalPiPolicy {
  allowPersonalPiProviders: boolean;
  piDefaultSource: PiDefaultSource;
}

export function isPiDefaultSource(value: unknown): value is PiDefaultSource {
  return value === 'managed' || value === 'pi-native';
}

/** Selection is not permission. An empty first matching policy never falls through. */
export async function resolvePersonalPiPolicy(kv: KVNamespace, groups: string[] = []): Promise<PersonalPiPolicy> {
  const denied: PersonalPiPolicy = { allowPersonalPiProviders: false, piDefaultSource: 'managed' };
  try {
    const [rawGroups, rawConfiguration] = await Promise.all([
      kv.get(SETUP_KEYS.GROUP_ROUTING), kv.get(SETUP_KEYS.REASONING_CONFIGURATION),
    ]);
    const policies: unknown = JSON.parse(rawGroups ?? '{}');
    if (!policies || typeof policies !== 'object' || Array.isArray(policies)) return denied;
    const configuration = parseReasoningConfiguration(rawConfiguration);
    const first = groups.find(group => Object.hasOwn(policies, group));
    if (first === undefined) {
      const fallback = configuration.fallbackRouting;
      if (fallback?.enabled !== true) return denied;
      return { allowPersonalPiProviders: fallback.allowPersonalPiProviders === true,
        piDefaultSource: fallback.piDefaultSource ?? 'managed' };
    }
    const policy = (policies as Record<string, unknown>)[first];
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return denied;
    const entry = policy as Record<string, unknown>;
    if (!Array.isArray(entry.routes) || !entry.routes.every(route => typeof route === 'string')
      || typeof entry.defaultRoute !== 'string' || !isPiReasoningLevel(entry.reasoning)
      || (entry.routes.length ? !entry.routes.includes(entry.defaultRoute) : entry.defaultRoute !== '' || entry.reasoning !== 'off')
      || (entry.allowPersonalPiProviders !== undefined && typeof entry.allowPersonalPiProviders !== 'boolean')
      || (entry.piDefaultSource !== undefined && !isPiDefaultSource(entry.piDefaultSource))) return denied;
    return {
      allowPersonalPiProviders: entry.allowPersonalPiProviders === true,
      piDefaultSource: entry.piDefaultSource ?? 'managed',
    };
  } catch { return denied; }
}
