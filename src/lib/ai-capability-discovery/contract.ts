import type { NormalizedReasoningProfile } from '../reasoning-profiles';
// Covers the entire finite current contract search (38 worst-case submissions),
// without making the limit grow when a model or saved profile is added.
export const MAX_CAPABILITY_SUBMISSIONS = 40;

export interface TargetCapabilityResult {
  schemaVersion: 1;
  assignable: boolean;
  classification: 'Verified' | 'Inconclusive' | 'Unsupported';
  explanation: string;
  capabilities?: CapabilitySummary;
  profile?: NormalizedReasoningProfile;
  report?: Record<string, any>;
  attempts: Array<{ contract: string; classification: string; capabilities?: CapabilitySummary; diagnostics: unknown[]; httpAttempts: number }>;
  accounting: { httpAttempts: number };
}

/** Shared sanitized result contract. No model catalog, credentials, executable
 * browser instructions or signed replay state belongs in this projection. */
export interface CapabilitySummary {
  schemaVersion: 1;
  tools: boolean;
  replay: boolean;
  cache: 'provider-prefix' | 'gateway-response' | 'inconclusive' | 'not-tested';
  nativePromptCache: boolean;
  reasoning: 'provider-default' | 'observed-enabled' | 'unverified';
  streaming: 'incremental' | 'not-observed';
  grade: 'Minimum' | 'Acceptable' | 'Optimal' | 'Not qualified';
}

export function capabilityMinimum(evidence: CapabilitySummary | undefined): boolean {
  return Boolean(evidence?.tools && evidence.replay && ['provider-prefix', 'gateway-response'].includes(evidence.cache)
    && (!evidence.nativePromptCache || evidence.cache === 'provider-prefix')
    && evidence.grade === (evidence.reasoning === 'unverified' ? 'Minimum' : evidence.streaming === 'incremental' ? 'Optimal' : 'Acceptable'));
}

export function parseCapabilitySummary(value: unknown): CapabilitySummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid capabilities');
  const item = value as Record<string, unknown>;
  const fields = ['schemaVersion', 'tools', 'replay', 'cache', 'nativePromptCache', 'reasoning', 'streaming', 'grade'];
  if (Object.keys(item).length !== fields.length || Object.keys(item).some((key) => !fields.includes(key))
    || item.schemaVersion !== 1 || !['tools', 'replay', 'nativePromptCache'].every((key) => typeof item[key] === 'boolean')
    || !['provider-prefix', 'gateway-response', 'inconclusive', 'not-tested'].includes(String(item.cache))
    || !['provider-default', 'observed-enabled', 'unverified'].includes(String(item.reasoning))
    || !['incremental', 'not-observed'].includes(String(item.streaming))
    || !['Minimum', 'Acceptable', 'Optimal', 'Not qualified'].includes(String(item.grade))) throw new Error('Invalid capabilities');
  return { ...item } as unknown as CapabilitySummary;
}
